// The codex and gemini adapters: the flags each tool policy becomes and how their event streams
// are read. Shapes follow codex-cli 0.153.4 (`codex exec --json`) and gemini 0.31.0 (stream-json).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as codex from "../server/lib/runners/codex.ts";
import * as gemini from "../server/lib/runners/gemini.ts";
import { ALWAYS_DENY } from "../server/lib/runners/claude.ts";
import { listRunners } from "../server/lib/runners/index.ts";
import type { RunEvent, RunSpec } from "../server/lib/runners/index.ts";

const base: RunSpec = { cwd: "/tmp/w", prompt: "do it" };
const val = (a: string[], flag: string) => a[a.indexOf(flag) + 1];
const configs = (a: string[]) => a.filter((_, i) => a[i - 1] === "-c");

test("codex: the tool policy becomes a sandbox, approvals never", () => {
  const sandbox = (mode: "none" | "readonly" | "edit" | "full") => configs(codex.buildArgs({ ...base, tools: { mode } })).find((c) => c.startsWith("sandbox_mode="));
  assert.equal(sandbox("none"), 'sandbox_mode="read-only"');
  assert.equal(sandbox("readonly"), 'sandbox_mode="read-only"');
  assert.equal(sandbox("edit"), 'sandbox_mode="workspace-write"');
  assert.equal(sandbox("full"), 'sandbox_mode="danger-full-access"');
  assert.equal(configs(codex.buildArgs(base)).find((c) => c.startsWith("sandbox_mode=")), 'sandbox_mode="workspace-write"', "edit by default");
  const a = codex.buildArgs(base);
  assert.deepEqual(a.slice(0, 2), ["exec", "--json"]);
  assert.ok(configs(a).includes('approval_policy="never"'));
  assert.ok(a.includes("--ignore-user-config") && a.includes("--skip-git-repo-check"));
  assert.equal(val(a, "-C"), "/tmp/w");
  assert.equal(a.at(-1), "-", "the prompt comes on stdin");
  assert.ok(!a.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("codex: model, effort, house rules, schema, resume", () => {
  const a = codex.buildArgs({ ...base, model: "gpt-x", effort: "max", systemPrompt: 'Rules: "quoted"\nnext line', addDirs: ["/extra"] }, "/tmp/schema.json");
  assert.equal(val(a, "-m"), "gpt-x");
  assert.ok(configs(a).includes('model_reasoning_effort="xhigh"'), "max maps to codex's highest");
  const dev = configs(a).find((c) => c.startsWith("developer_instructions="))!;
  assert.equal(JSON.parse(dev.slice("developer_instructions=".length)), 'Rules: "quoted"\nnext line');
  assert.equal(val(a, "--output-schema"), "/tmp/schema.json");
  assert.equal(val(a, "--add-dir"), "/extra");
  const r = codex.buildArgs({ ...base, resumeSessionId: "019a-thread", addDirs: ["/extra"] });
  assert.deepEqual(r.slice(0, 3), ["exec", "resume", "--json"]);
  assert.deepEqual(r.slice(-2), ["019a-thread", "-"]);
  assert.ok(!r.includes("-C") && !r.includes("--add-dir") && !r.includes("--sandbox"), "resume takes none of these; -c carries the sandbox");
  assert.ok(configs(r).includes('sandbox_mode="workspace-write"'));
});

test("codex: strictSchema makes optional properties required and nullable", () => {
  const s = codex.strictSchema({ title: "review", type: "object", required: ["verdict"], properties: { verdict: { type: "string", enum: ["a", "b"] }, line: { type: "integer" }, kind: { type: "string", enum: ["x"] }, items: { type: "array", items: { type: "object", properties: { f: { type: "string" } } } } } }) as Record<string, any>;
  assert.equal(s.title, undefined);
  assert.deepEqual(s.required, ["verdict", "line", "kind", "items"]);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.verdict, { type: "string", enum: ["a", "b"] });
  assert.deepEqual(s.properties.line, { type: ["integer", "null"] });
  assert.deepEqual(s.properties.kind, { type: ["string", "null"], enum: ["x", null] });
  assert.deepEqual(s.properties.items.type, ["array", "null"]);
  assert.deepEqual(s.properties.items.items, { type: "object", properties: { f: { type: ["string", "null"] } }, required: ["f"], additionalProperties: false });
});

test("codex: the --json stream becomes factory events", () => {
  const events: RunEvent[] = [];
  const state = codex.newState({ ...base, model: "gpt-x" });
  const lines = [
    { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Looking at the tests**" } },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc 'npm test'", aggregated_output: "", exit_code: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc 'npm test'", aggregated_output: "1 failing\n", exit_code: 1, status: "failed" } },
    { type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }, { path: "src/b.ts", kind: "add" }], status: "completed" } },
    { type: "item.completed", item: { id: "item_3", type: "mcp_tool_call", server: "docs", tool: "search", arguments: { q: "x" }, result: { content: [] }, status: "completed" } },
    { type: "item.completed", item: { id: "item_4", type: "todo_list", items: [{ text: "fix", completed: true }, { text: "test", completed: false }] } },
    { type: "item.completed", item: { id: "item_5", type: "agent_message", text: "Fixed the failing test." } },
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 64 } },
  ];
  for (const l of lines) codex.parseLine(l, (e) => events.push(e), state);
  assert.deepEqual(events[0], { type: "init", sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53", model: "gpt-x" });
  assert.deepEqual(events[1], { type: "log", level: "info", message: "**Looking at the tests**" });
  assert.deepEqual(events[2], { type: "tool_use", name: "Bash", input: { command: "bash -lc 'npm test'" }, id: "item_1" });
  assert.deepEqual(events[3], { type: "tool_result", id: "item_1", output: "1 failing\n", isError: true });
  assert.deepEqual(events[4], { type: "tool_use", name: "Edit", input: { file_path: "update src/a.ts, add src/b.ts", changes: lines[5].item!.changes }, id: "item_2" });
  assert.deepEqual(events[5], { type: "tool_result", id: "item_2", output: "update src/a.ts, add src/b.ts", isError: false });
  assert.deepEqual(events[6], { type: "tool_use", name: "mcp:docs.search", input: { q: "x" }, id: "item_3" });
  assert.deepEqual(events[7], { type: "tool_result", id: "item_3", output: '{"content":[]}', isError: false });
  assert.deepEqual(events[8], { type: "log", level: "info", message: "plan: [x] fix; [ ] test" });
  assert.deepEqual(events[9], { type: "text", text: "Fixed the failing test." });
  assert.deepEqual(events[10], { type: "log", level: "warn", message: "Reconnecting... 1/5" });
  assert.equal(events.length, 11, "item.started is not repeated on completion");
  assert.equal(state.sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
  assert.equal(state.lastText, "Fixed the failing test.");
  assert.equal(state.toolCalls, 3);
  assert.equal(state.completed, true);
  assert.deepEqual(state.usage, { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 64 });
  codex.parseLine({ type: "turn.failed", error: { message: "usage limit reached" } }, () => {}, state);
  assert.equal(state.failed, "usage limit reached");
});

test("gemini: the tool policy becomes an approval mode and allowed commands", () => {
  const mode = (m: "none" | "readonly" | "edit" | "full") => gemini.buildArgs({ ...base, tools: { mode: m } });
  assert.equal(val(mode("none"), "--approval-mode"), "default");
  assert.equal(val(mode("readonly"), "--approval-mode"), "default");
  assert.equal(val(mode("edit"), "--approval-mode"), "auto_edit");
  assert.equal(val(mode("full"), "--approval-mode"), "yolo");
  const allowed = (a: string[]) => a.filter((x) => x.startsWith("--allowed-tools=")).map((x) => x.slice("--allowed-tools=".length));
  assert.deepEqual(allowed(mode("none")), [], "no shell at all");
  assert.deepEqual(allowed(mode("full")), []);
  assert.ok(allowed(mode("readonly")).includes("run_shell_command(git log)"));
  assert.ok(!allowed(mode("readonly")).includes("run_shell_command(npm)"));
  assert.ok(allowed(mode("edit")).includes("run_shell_command(npm)"));
  assert.ok(allowed(mode("edit")).includes("run_shell_command(pwd)"));
  const custom = allowed(gemini.buildArgs({ ...base, tools: { mode: "edit", allow: ["Bash(terraform plan:*)", "WebFetch", "Edit(src/**)"] } }));
  assert.ok(custom.includes("run_shell_command(terraform plan)") && custom.includes("web_fetch"));
  assert.ok(!custom.some((c) => c.startsWith("replace")), "a path-scoped allow cannot be expressed and is left out");
  const a = gemini.buildArgs({ ...base, model: "gemini-x", addDirs: ["/a", "/b"], resumeSessionId: "6f1c-uuid" }, "/tmp/deny.toml");
  assert.deepEqual(a.slice(0, 4), ["--prompt", "", "--output-format", "stream-json"]);
  assert.equal(val(a, "-m"), "gemini-x");
  assert.ok(a.includes("--policy=/tmp/deny.toml") && a.includes("--extensions=none") && a.includes("--allowed-mcp-server-names=none"));
  assert.ok(a.includes("--include-directories=/a,/b"));
  assert.equal(val(a, "--resume"), "6f1c-uuid");
});

test("gemini: deny rules become a policy file", () => {
  assert.deepEqual(gemini.translate("Bash(git push:*)"), { tool: "run_shell_command", prefix: "git push" });
  assert.deepEqual(gemini.translate("Bash(pwd)"), { tool: "run_shell_command", prefix: "pwd" });
  assert.deepEqual(gemini.translate("Read"), { tool: "read_file" });
  assert.deepEqual(gemini.translate("Edit(secrets/**)"), { tool: "replace", pattern: true });
  assert.equal(gemini.translate("not a rule!"), null);
  const toml = gemini.denyPolicy([...ALWAYS_DENY, "Edit(secrets/**)", "Bash(git push:*)"]);
  assert.equal((toml.match(/\[\[rule\]\]/g) ?? []).length, ALWAYS_DENY.length + 1, "duplicates collapse");
  assert.match(toml, /\[\[rule\]\]\ntoolName = "run_shell_command"\ncommandPrefix = "git push"\ndecision = "deny"\npriority = 990\n/);
  assert.match(toml, /commandPrefix = "rm -rf \$HOME"/);
  assert.match(toml, /toolName = "replace"\ndecision = "deny"/, "a path-scoped deny denies the whole tool");
});

test("gemini: the house rules lead a new session's prompt; a schema adds the answer format", () => {
  assert.equal(gemini.buildInput({ ...base, systemPrompt: "RULES" }), "RULES\n\n---\n\ndo it");
  assert.equal(gemini.buildInput({ ...base, systemPrompt: "RULES", resumeSessionId: "s" }), "do it", "the resumed session has them already");
  assert.match(gemini.buildInput({ ...base, schema: { type: "object" } }), /^do it\n\n---\n\nAnswer format: .*```json/s);
});

test("gemini: the stream-json events become factory events", () => {
  const events: RunEvent[] = [];
  const state = gemini.newState(base);
  const lines = [
    { type: "init", timestamp: "t", session_id: "6f1c0a52-uuid", model: "gemini-2.5-pro" },
    { type: "message", timestamp: "t", role: "user", content: "do it" },
    { type: "message", timestamp: "t", role: "assistant", content: "Let me ", delta: true },
    { type: "message", timestamp: "t", role: "assistant", content: "look.", delta: true },
    { type: "tool_use", timestamp: "t", tool_name: "run_shell_command", tool_id: "c1", parameters: { command: "ls" } },
    { type: "tool_use", timestamp: "t", tool_name: "read_file", tool_id: "c2", parameters: { file_path: "a.ts" } },
    { type: "tool_result", timestamp: "t", tool_id: "c1", status: "success", output: "a.ts" },
    { type: "tool_result", timestamp: "t", tool_id: "c2", status: "error", error: { type: "policy_violation", message: "denied by policy" } },
    { type: "error", timestamp: "t", severity: "warning", message: "Loop detected, stopping execution" },
    { type: "message", timestamp: "t", role: "assistant", content: "```json\n{\"ok\": true}\n```", delta: true },
    { type: "result", timestamp: "t", status: "success", stats: { total_tokens: 10, input_tokens: 7, output_tokens: 3, cached: 0, input: 7, duration_ms: 1200, tool_calls: 2 } },
  ];
  for (const l of lines) gemini.parseLine(l, (e) => events.push(e), state);
  assert.deepEqual(events, [
    { type: "init", sessionId: "6f1c0a52-uuid", model: "gemini-2.5-pro" },
    { type: "text", text: "Let me look." },
    { type: "tool_use", name: "Bash", input: { command: "ls" }, id: "c1" },
    { type: "tool_use", name: "Read", input: { file_path: "a.ts" }, id: "c2" },
    { type: "tool_result", id: "c1", output: "a.ts", isError: false },
    { type: "tool_result", id: "c2", output: "denied by policy", isError: true },
    { type: "denied", tool: "read_file", message: "denied by policy" },
    { type: "log", level: "warn", message: "Loop detected, stopping execution" },
    { type: "text", text: "```json\n{\"ok\": true}\n```" },
  ]);
  assert.equal(state.sessionId, "6f1c0a52-uuid");
  assert.equal(state.rounds, 2, "one round of tool calls, one final answer");
  assert.equal(state.lastText, "```json\n{\"ok\": true}\n```");
  assert.equal(state.result?.status, "success");
});

test("register() adds both runners; their capabilities say what they can do", () => {
  codex.register();
  gemini.register();
  const ids = listRunners().map((r) => r.id);
  assert.ok(ids.includes("codex") && ids.includes("gemini"));
  for (const r of [codex.codexRunner, gemini.geminiRunner]) assert.deepEqual(r.capabilities, { resume: true, structuredOutput: true, tools: true, costReporting: false, budget: false });
});

test("check() reports a missing binary instead of throwing", async () => {
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const r = await codex.codexRunner.check();
    if (!r.ok) assert.match(r.detail ?? "", /codex/);
  } finally { process.env.PATH = saved; }
});
