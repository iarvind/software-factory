// The Gemini CLI (`gemini -p`) on this Mac's Google sign-in (or GEMINI_API_KEY), driven headless.
//
// Output is stream-json, one event per line: init (session id, model), message (our prompt
// echoed, then the assistant's text in deltas), tool_use, tool_result, error (warnings, loop
// detection) and a final result with token stats (no dollars). The prompt goes in on stdin with
// an empty -p, which Gemini appends. Exit codes: 1 error, 42 bad input, 53 turn limit.
// A session is resumed by its id: 0.31 takes `--resume <uuid>` as well as "latest" or an index.
// Sessions are kept per project directory, and the factory resumes in the same worktree.
//
// Headless Gemini drops every tool that would need a confirmation, so the approval mode is also
// the tool list. The tool policy maps like this (checked against gemini 0.31.0):
//   none     → default mode, no shell: read, search and list tools only. Gemini cannot run with
//              no tools at all; this is the least it has.
//   readonly → default mode plus the read-only shell commands of claude.ts (git log, ls, rg…).
//   edit     → auto_edit (file edits approved) plus claude.ts's toolchain shell commands.
//   full     → yolo.
// Allowed commands go in as --allowed-tools run_shell_command(<prefix>); anything else that needs
// a confirmation is denied, never asked. ALWAYS_DENY and the project's deny list become deny rules
// in a policy file (--policy: user tier, priority above everything the flags allow, yolo included).
// Allow and deny entries are written the claude way (`Bash(git log:*)`, `Read`) and translated.
// There is no schema flag and no system-prompt flag: the house rules lead the first prompt and a
// schema becomes an instruction to answer in a fenced JSON block, read back with extractJson. The
// turn cap is a setting, not a flag: maxTurns is enforced here by counting model rounds. Extensions
// and MCP servers from ~/.gemini stay out (-e none, an MCP allow-list naming nothing); its sign-in is used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv, registerRunner, type AgentRunner, type RunEvent, type RunResult, type RunSpec } from "./index.ts";
import { ALWAYS_DENY, EDIT_ALLOW, READONLY_ALLOW } from "./claude.ts";
import { clip, extractJson, schemaInstruction, spawnCli } from "./util.ts";

const BIN = process.env.GEMINI_BIN || "gemini";
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "";
const USER_EXTRAS = process.env.GEMINI_USER_EXTRAS === "1";

const TO_GEMINI: Record<string, string> = { Bash: "run_shell_command", Read: "read_file", Edit: "replace", MultiEdit: "replace", Write: "write_file", Grep: "grep_search", Glob: "glob", LS: "list_directory", WebFetch: "web_fetch", WebSearch: "google_web_search" };
const FROM_GEMINI = Object.fromEntries(Object.entries(TO_GEMINI).filter(([k]) => k !== "MultiEdit").map(([k, v]) => [v, k]));

/** `Bash(git log:*)` → run_shell_command with prefix "git log"; `Read` → read_file; a path pattern (`Edit(src/**)`) cannot be expressed and is flagged. */
export function translate(rule: string): { tool: string; prefix?: string; pattern?: boolean } | null {
  const m = /^([\w.-]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return null;
  const tool = TO_GEMINI[m[1]] ?? m[1];
  if (m[2] === undefined) return { tool };
  if (tool !== "run_shell_command") return { tool, pattern: true };
  const prefix = m[2].replace(/:?\*$/, "").trim();
  return prefix ? { tool, prefix } : { tool };
}

/** The deny rules as a policy file. A JSON string is a valid TOML basic string. Patterned rules deny the whole tool (the safer reading). */
export function denyPolicy(rules: string[]): string {
  const out: string[] = [];
  for (const r of new Set(rules)) {
    const t = translate(r);
    if (!t) continue;
    out.push("[[rule]]", `toolName = ${JSON.stringify(t.tool)}`, ...(t.prefix ? [`commandPrefix = ${JSON.stringify(t.prefix)}`] : []), 'decision = "deny"', "priority = 990", "");
  }
  return out.join("\n");
}

export function buildArgs(spec: RunSpec, policyFile?: string): string[] {
  const mode = spec.tools?.mode ?? "edit";
  const args = ["--prompt", "", "--output-format", "stream-json", "--approval-mode", mode === "full" ? "yolo" : mode === "edit" ? "auto_edit" : "default"];
  const model = spec.model || DEFAULT_MODEL;
  if (model) args.push("-m", model);
  const allow = mode === "readonly" ? [...READONLY_ALLOW, ...(spec.tools?.allow ?? [])] : mode === "edit" ? [...EDIT_ALLOW, ...(spec.tools?.allow ?? [])] : [];
  for (const a of new Set(allow)) {
    const t = translate(a);
    if (t && !t.pattern) args.push(`--allowed-tools=${t.prefix ? `${t.tool}(${t.prefix})` : t.tool}`);
  }
  if (policyFile) args.push(`--policy=${policyFile}`);
  if (!USER_EXTRAS) args.push("--extensions=none", "--allowed-mcp-server-names=none");
  if (spec.addDirs?.length) args.push(`--include-directories=${spec.addDirs.join(",")}`);
  if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
  return args;
}

/** What goes in on stdin: the house rules first on a new session, then the prompt, then the answer format when a schema is wanted. */
export function buildInput(spec: RunSpec): string {
  return `${spec.systemPrompt && !spec.resumeSessionId ? `${spec.systemPrompt}\n\n---\n\n` : ""}${spec.prompt}${spec.schema ? schemaInstruction(spec.schema) : ""}`;
}

type Stats = { total_tokens?: number; input_tokens?: number; output_tokens?: number; cached?: number; input?: number; duration_ms?: number; tool_calls?: number };
type Msg = {
  type?: string; session_id?: string; model?: string; role?: string; content?: string; delta?: boolean; tool_name?: string; tool_id?: string; parameters?: unknown;
  status?: string; output?: string; error?: { type?: string; message?: string }; severity?: string; message?: string; stats?: Stats;
};
export type GeminiState = { sessionId?: string; text: string; lastText: string; allText: string; rounds: number; awaiting: boolean; tools: Map<string, string>; result?: Msg; lastError?: string };
export const newState = (spec: RunSpec): GeminiState => ({ sessionId: spec.resumeSessionId, text: "", lastText: "", allText: "", rounds: 0, awaiting: true, tools: new Map() });

/** The assistant's text so far (it arrives in deltas) becomes one text event. */
function flushText(state: GeminiState, onEvent: (e: RunEvent) => void): void {
  if (!state.text.trim()) { state.text = ""; return; }
  state.lastText = state.text;
  state.allText += `${state.text}\n`;
  onEvent({ type: "text", text: state.text });
  state.text = "";
}

/** Turns one stream-json line into factory events. Exported for the tests. */
export function parseLine(m: Msg | null, onEvent: (e: RunEvent) => void, state: GeminiState): void {
  if (!m || typeof m !== "object") return;
  const flush = () => flushText(state, onEvent);
  const round = () => { if (state.awaiting) { state.rounds++; state.awaiting = false; } };
  if (m.type === "init") { state.sessionId = m.session_id; onEvent({ type: "init", sessionId: m.session_id ?? "", model: m.model }); }
  else if (m.type === "message" && m.role === "assistant") { round(); if (m.delta) state.text += m.content ?? ""; else { flush(); state.text = m.content ?? ""; flush(); } }
  else if (m.type === "tool_use") {
    round(); flush();
    const name = FROM_GEMINI[m.tool_name ?? ""] ?? m.tool_name ?? "?";
    if (m.tool_id) state.tools.set(m.tool_id, m.tool_name ?? "?");
    onEvent({ type: "tool_use", name, input: m.parameters, id: m.tool_id });
  } else if (m.type === "tool_result") {
    state.awaiting = true;
    const isError = m.status === "error";
    onEvent({ type: "tool_result", id: m.tool_id, output: clip(m.output ?? m.error?.message ?? ""), isError });
    if (isError && m.error?.type === "policy_violation") onEvent({ type: "denied", tool: state.tools.get(m.tool_id ?? "") ?? "?", message: m.error.message });
  } else if (m.type === "error") {
    state.lastError = m.message;
    onEvent({ type: "log", level: m.severity === "error" ? "error" : "warn", message: (m.message ?? "").slice(0, 2000) });
  } else if (m.type === "result") { flush(); state.result = m; }
}

export const geminiRunner: AgentRunner = {
  id: "gemini",
  label: "Gemini CLI (gemini -p)",
  capabilities: { resume: true, structuredOutput: true, tools: true, costReporting: false, budget: false },

  async check() {
    try {
      const { stdout } = await promisify(execFile)(BIN, ["--version"], { env: childEnv(), timeout: 15000 });
      return { ok: true, version: stdout.trim(), detail: BIN };
    } catch (e) {
      return { ok: false, detail: `${BIN}: ${e instanceof Error ? e.message : String(e)}` };
    }
  },

  async run(spec, onEvent, signal): Promise<RunResult> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-gemini-"));
    const policyFile = path.join(tmp, "deny.toml");
    fs.writeFileSync(policyFile, denyPolicy([...ALWAYS_DENY, ...(spec.tools?.deny ?? [])]));
    const state = newState(spec);
    try {
      const x = await spawnCli({
        bin: BIN, args: buildArgs(spec, policyFile), cwd: spec.cwd, env: childEnv(spec.env, { agent: true }), input: buildInput(spec), timeoutMs: spec.timeoutMs, signal,
        onLine: (obj, raw, stop) => {
          if (obj == null) { if (raw.trim()) onEvent({ type: "log", level: "info", message: raw.slice(0, 2000) }); return; }
          parseLine(obj as Msg, onEvent, state);
          if (spec.maxTurns && state.rounds > spec.maxTurns) stop("error_max_turns");
        },
      });
      flushText(state, onEvent); // a run cut short leaves text that no result flushed
      const r = state.result;
      const s = r?.stats;
      const base = { sessionId: state.sessionId, result: state.lastText, turns: state.rounds, usage: s, durationMs: s?.duration_ms ?? x.durationMs, exitCode: x.code, stderr: x.stderr };
      if (x.killedBy) return { ...base, ok: false, error: x.killedBy };
      if (x.code === 53) return { ...base, ok: false, error: "error_max_turns" };
      if (!r || r.status !== "success" || x.code !== 0) {
        const why = r?.error?.message ?? state.lastError ?? (x.stderr.trim().split("\n").pop() || "");
        return { ...base, ok: false, error: `${r ? "error_during_execution" : `no result (exit ${x.code})`}${why ? `: ${why.slice(0, 300)}` : ""}` };
      }
      if (!spec.schema) return { ...base, ok: true };
      const structured = extractJson(state.lastText) ?? extractJson(state.allText);
      return structured ? { ...base, ok: true, structured } : { ...base, ok: false, error: "no structured answer: the final message held no JSON object" };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
};

export function register(): void { registerRunner(geminiRunner); }
