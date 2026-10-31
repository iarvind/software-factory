// The codex and gemini adapters' run(), end to end against stand-in binaries that speak each
// CLI's event stream: the prompt on stdin, the schema file, structured answers, the turn cap,
// cancel, timeout and the SIGKILL fallback, and how exit codes become errors.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.ts";
import type { RunEvent, RunSpec } from "../server/lib/runners/index.ts";

const dir = tempDir("factory-stub-");
const stub = path.join(dir, "stub.cjs");
fs.writeFileSync(stub, `#!/usr/bin/env node
const fs = require("fs");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const hang = () => setInterval(() => {}, 1000);
if (process.argv.includes("--version")) { console.log("stub 1.2.3"); process.exit(0); }
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const at = args.indexOf("--output-schema");
  fs.writeFileSync(process.env.STUB_OUT, JSON.stringify({ args, input, cwd: process.cwd(), schema: at >= 0 ? fs.readFileSync(args[at + 1], "utf8") : null, env: Object.keys(process.env) }));
  const mode = process.env.STUB_MODE;
  if (process.env.STUB_KIND === "codex") {
    out({ type: "thread.started", thread_id: "thread-1" });
    out({ type: "turn.started" });
    if (mode === "loop") { for (let i = 0; i < 10; i++) out({ type: "item.completed", item: { id: "c" + i, type: "command_execution", command: "ls", aggregated_output: "", exit_code: 0, status: "completed" } }); return hang(); }
    if (mode === "hang") return hang();
    if (mode === "stubborn") { process.on("SIGTERM", () => {}); return hang(); }
    if (mode === "fail") { out({ type: "turn.failed", error: { message: "usage limit reached" } }); process.exit(1); }
    out({ type: "item.completed", item: { id: "m", type: "agent_message", text: process.env.STUB_TEXT || "done" } });
    out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 } });
    return;
  }
  out({ type: "init", session_id: "gem-session", model: "gemini-x" });
  out({ type: "message", role: "user", content: input });
  if (mode === "turns") process.exit(53);
  if (mode === "error") { out({ type: "result", status: "error", error: { type: "API", message: "quota exceeded" } }); process.exit(1); }
  out({ type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { file_path: "a" } });
  out({ type: "tool_result", tool_id: "t1", status: "success", output: "contents" });
  for (const part of (process.env.STUB_TEXT || "done").match(/[\\s\\S]{1,7}/g)) out({ type: "message", role: "assistant", content: part, delta: true });
  out({ type: "result", status: "success", stats: { total_tokens: 9, input_tokens: 6, output_tokens: 3, cached: 0, input: 6, duration_ms: 42, tool_calls: 1 } });
});
`);
fs.chmodSync(stub, 0o755);
process.env.CODEX_BIN = stub;
process.env.GEMINI_BIN = stub;
const { codexRunner } = await import("../server/lib/runners/codex.ts");
const { geminiRunner } = await import("../server/lib/runners/gemini.ts");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const outFile = path.join(dir, "out.json");
const seen = () => JSON.parse(fs.readFileSync(outFile, "utf8")) as { args: string[]; input: string; cwd: string; schema: string | null; env: string[] };
const spec = (kind: string, mode: string, extra: Partial<RunSpec> = {}, text?: string): RunSpec => ({ cwd: dir, prompt: "Do the thing.", ...extra, env: { STUB_KIND: kind, STUB_MODE: mode, STUB_OUT: outFile, ...(text ? { STUB_TEXT: text } : {}) } });
async function go(runner: typeof codexRunner, s: RunSpec, signal = new AbortController().signal) {
  const events: RunEvent[] = [];
  const r = await runner.run(s, (e) => events.push(e), signal);
  return { r, events };
}
const tmpLeft = (prefix: string) => fs.readdirSync(path.dirname(fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "probe-")))).filter((f) => f.startsWith(prefix));

test("codex: a run with the prompt on stdin, the session id and usage", async () => {
  process.env.GH_TOKEN = "should-not-leak";
  const { r, events } = await go(codexRunner, spec("codex", "ok", { systemPrompt: "RULES", tools: { mode: "readonly" } }));
  delete process.env.GH_TOKEN;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.sessionId, "thread-1");
  assert.equal(r.result, "done");
  assert.equal(r.turns, 1);
  assert.deepEqual(r.usage, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 });
  assert.equal(r.costUsd, undefined, "codex reports tokens, not dollars");
  assert.equal(r.exitCode, 0);
  const s = seen();
  assert.equal(s.input, "Do the thing.");
  assert.equal(s.cwd, dir);
  assert.ok(s.args.includes('sandbox_mode="read-only"'));
  assert.ok(s.args.includes('developer_instructions="RULES"'));
  assert.ok(!s.env.includes("GH_TOKEN"), "agents do not get the GitHub token");
  assert.deepEqual(events.map((e) => e.type), ["init", "text"]);
});

test("codex: a schema goes to --output-schema (strict) and the answer is parsed", async () => {
  const before = tmpLeft("factory-codex-").length;
  const schema = { title: "note", type: "object", required: ["note"], properties: { note: { type: "string" }, tags: { type: "array", items: { type: "string" } } } };
  const { r } = await go(codexRunner, spec("codex", "ok", { schema }, '{"note": "learned a thing", "tags": null}'));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.structured, { note: "learned a thing", tags: null });
  const sent = JSON.parse(seen().schema!);
  assert.deepEqual(sent.required, ["note", "tags"]);
  assert.equal(sent.title, undefined);
  assert.equal(tmpLeft("factory-codex-").length, before, "the schema file is cleaned up");
  const bad = await go(codexRunner, spec("codex", "ok", { schema }, "I could not decide."));
  assert.equal(bad.r.ok, false);
  assert.match(bad.r.error!, /no structured answer/);
});

test("codex: resume sends the thread id; failures and the turn cap become errors", async () => {
  await go(codexRunner, spec("codex", "ok", { resumeSessionId: "thread-0" }));
  const s = seen();
  assert.deepEqual(s.args.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(s.args.slice(-2), ["thread-0", "-"]);
  const failed = await go(codexRunner, spec("codex", "fail"));
  assert.equal(failed.r.ok, false);
  assert.equal(failed.r.error, "error_during_execution: usage limit reached");
  const loop = await go(codexRunner, spec("codex", "loop", { maxTurns: 3 }));
  assert.equal(loop.r.ok, false);
  assert.equal(loop.r.error, "error_max_turns");
  assert.ok(loop.r.turns! >= 4);
});

test("codex: cancel and timeout stop the process; SIGKILL when SIGTERM is ignored", async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 300);
  const t0 = Date.now();
  const c = await go(codexRunner, spec("codex", "hang"), ctrl.signal);
  assert.equal(c.r.error, "cancelled");
  assert.equal(c.r.sessionId, "thread-1", "the session id survives a cancel");
  assert.ok(Date.now() - t0 < 4000);
  const pre = new AbortController();
  pre.abort();
  assert.equal((await go(codexRunner, spec("codex", "hang"), pre.signal)).r.error, "cancelled");
  const t = await go(codexRunner, spec("codex", "hang", { timeoutMs: 300 }));
  assert.equal(t.r.error, "timeout");
  const t1 = Date.now();
  const k = await go(codexRunner, spec("codex", "stubborn", { timeoutMs: 200 }));
  assert.equal(k.r.error, "timeout");
  assert.ok(Date.now() - t1 >= 4500, "waited for SIGKILL");
});

test("gemini: the house rules and answer format go on stdin; the fenced answer is parsed", async () => {
  const before = tmpLeft("factory-gemini-").length;
  const schema = { title: "plan", type: "object", properties: { summary: { type: "string" } } };
  const { r, events } = await go(geminiRunner, spec("gemini", "ok", { systemPrompt: "RULES", schema, tools: { mode: "edit", deny: ["Bash(terraform:*)"] } }, 'Here it is:\n```json\n{"summary": "do it"}\n```'));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.sessionId, "gem-session");
  assert.deepEqual(r.structured, { summary: "do it" });
  assert.equal(r.turns, 2);
  assert.equal(r.durationMs, 42);
  assert.deepEqual(r.usage, { total_tokens: 9, input_tokens: 6, output_tokens: 3, cached: 0, input: 6, duration_ms: 42, tool_calls: 1 });
  const s = seen();
  assert.match(s.input, /^RULES\n\n---\n\nDo the thing\.\n\n---\n\nAnswer format:/);
  assert.deepEqual(s.args.slice(0, 2), ["--prompt", ""]);
  assert.ok(s.args.includes("auto_edit"));
  assert.ok(s.args.some((a) => a.startsWith("--policy=")));
  assert.equal(tmpLeft("factory-gemini-").length, before, "the policy file is cleaned up");
  assert.deepEqual(events.map((e) => e.type), ["init", "tool_use", "tool_result", "text"]);
});

test("gemini: resume by session id; exit 53 is the turn cap; an error result fails", async () => {
  await go(geminiRunner, spec("gemini", "ok", { resumeSessionId: "gem-session", systemPrompt: "RULES" }));
  const s = seen();
  assert.equal(s.args[s.args.indexOf("--resume") + 1], "gem-session");
  assert.equal(s.input, "Do the thing.", "a resumed session has the rules already");
  assert.equal((await go(geminiRunner, spec("gemini", "turns"))).r.error, "error_max_turns");
  const e = await go(geminiRunner, spec("gemini", "error"));
  assert.equal(e.r.ok, false);
  assert.equal(e.r.error, "error_during_execution: quota exceeded");
});

test("check() runs --version with the configured binary", async () => {
  for (const runner of [codexRunner, geminiRunner]) assert.deepEqual(await runner.check(), { ok: true, version: "stub 1.2.3", detail: stub });
});
