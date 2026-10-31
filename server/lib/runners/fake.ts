// A runner that does not call any model: for the tests, for demos, and for when the real
// one is unreachable and a dry run is wanted. It narrates a few steps, and when it is
// allowed to edit it leaves a real commit in the working directory so the rest of the
// pipeline (verify, push, PR) has something to work with. Structured answers come from the
// schema's title: "plan" and "note" get believable canned answers.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv, type AgentRunner, type RunResult, type RunSpec } from "./index.ts";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FakeBehaviour = { fail?: boolean; needsInfo?: boolean; delayMs?: number; noCommit?: boolean; structured?: unknown };
/** Tests set this; FAKE_BEHAVIOUR in env does the same for a demo. */
export let fakeBehaviour: FakeBehaviour = (() => { try { return JSON.parse(process.env.FAKE_BEHAVIOUR || "{}"); } catch { return {}; } })();
export const setFakeBehaviour = (b: FakeBehaviour) => { fakeBehaviour = b; };

function canned(spec: RunSpec, title: string): unknown {
  if (fakeBehaviour.structured !== undefined) return fakeBehaviour.structured;
  if (title === "plan") {
    const m = /Title:\s*(.+)/.exec(spec.prompt);
    return {
      summary: `Implement: ${m?.[1]?.trim() ?? "the request"}`,
      kind: "feature", size: "s", risk: "low",
      clarity: fakeBehaviour.needsInfo ? "needs_info" : "clear",
      questions: fakeBehaviour.needsInfo ? ["Which page should this appear on?"] : [],
      steps: ["Add FACTORY_NOTES.md describing the change", "Run the tests"],
      files: ["FACTORY_NOTES.md"],
      tests: ["existing suite"],
      risks: [],
      acceptance: ["A note file exists describing the change"],
      estimate_minutes: 5,
    };
  }
  if (title === "note") return { note: "The fake runner did this one; nothing to learn beyond that the pipeline works end to end.", tags: ["fake"] };
  if (title === "review") return { verdict: "approve", summary: "Looks fine (fake review).", findings: [] };
  return { ok: true };
}

export const fakeRunner: AgentRunner = {
  id: "fake",
  label: "Fake (no model)",
  capabilities: { resume: true, structuredOutput: true, tools: true, costReporting: true, budget: false },
  async check() { return { ok: true, version: "fake", detail: "answers without a model" }; },
  async run(spec, onEvent, signal): Promise<RunResult> {
    const started = Date.now();
    const sessionId = spec.resumeSessionId ?? spec.sessionId ?? randomUUID();
    onEvent({ type: "init", sessionId, model: "fake", tools: spec.tools?.mode === "none" ? [] : ["Read", "Edit", "Bash"] });
    await sleep(fakeBehaviour.delayMs ?? 50);
    if (signal.aborted) return { ok: false, sessionId, durationMs: Date.now() - started, exitCode: null, error: "cancelled" };
    const title = (spec.schema as { title?: string } | undefined)?.title ?? "";
    if (fakeBehaviour.fail) {
      onEvent({ type: "text", text: "I could not do this." });
      return { ok: false, sessionId, result: "failed on purpose", durationMs: Date.now() - started, exitCode: 1, error: "error_during_execution", costUsd: 0.01, turns: 1 };
    }
    if (spec.schema) {
      onEvent({ type: "text", text: `Answering with a ${title || "structured"} object.` });
      return { ok: true, sessionId, result: "", structured: canned(spec, title), durationMs: Date.now() - started, exitCode: 0, costUsd: 0.002, turns: 1 };
    }
    if ((spec.tools?.mode === "edit" || spec.tools?.mode === "full") && !fakeBehaviour.noCommit) {
      const file = path.join(spec.cwd, "FACTORY_NOTES.md");
      // A conflict round: keep both sides of every marker block, which is what a sensible agent would do with a notes file.
      if (/conflict markers/.test(spec.prompt) && fs.existsSync(file)) {
        const resolved = fs.readFileSync(file, "utf8").replace(/^<{7}[^\n]*\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7}[^\n]*\n/gm, "$1$2");
        fs.writeFileSync(file, resolved);
        onEvent({ type: "tool_use", name: "Edit", input: { file_path: file }, id: "t0" });
        onEvent({ type: "tool_result", id: "t0", output: "resolved" });
      }
      const m = /Title:\s*(.+)/.exec(spec.prompt);
      onEvent({ type: "tool_use", name: "Write", input: { file_path: file }, id: "t1" });
      fs.appendFileSync(file, `- ${new Date().toISOString()}: ${m?.[1]?.trim() ?? "change"} (fake runner${spec.resumeSessionId ? ", follow-up" : ""})\n`);
      onEvent({ type: "tool_result", id: "t1", output: "ok" });
      const env = childEnv();
      try {
        await exec("git", ["add", "-A"], { cwd: spec.cwd, env });
        await exec("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `${m?.[1]?.trim() ?? "Change"} (fake)`], { cwd: spec.cwd, env });
        onEvent({ type: "tool_use", name: "Bash", input: { command: "git commit -m …" }, id: "t2" });
        onEvent({ type: "tool_result", id: "t2", output: "committed" });
      } catch (e) {
        onEvent({ type: "log", level: "warn", message: `fake commit failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    onEvent({ type: "text", text: "Done. I added a note file and committed it." });
    return { ok: true, sessionId, result: "Done. I added a note file and committed it.", durationMs: Date.now() - started, exitCode: 0, costUsd: 0.05, turns: 3, usage: { fake: true } };
  },
};
