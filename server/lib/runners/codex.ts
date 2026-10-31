// The OpenAI Codex CLI (`codex exec`) on this Mac's saved login (ChatGPT plan or API key), driven headless.
//
// Output is --json, one event per line: thread.started (the thread id, which is the session id
// `codex exec resume <id>` takes), turn.started, item.started / item.completed for every agent
// message, reasoning summary, shell command, file change, MCP call and web search, then
// turn.completed with token usage (no dollars) or turn.failed. The prompt goes in on stdin (`-`).
//
// The tool policy becomes a sandbox; approvals are always "never", so nothing waits for a person
// and anything the sandbox refuses simply fails. Codex has no per-command allow or deny lists on
// its command line, so the sandbox is the whole boundary (checked against codex-cli 0.153.4):
//   none     → read-only. Codex cannot run without its tools; read-only is the safest it has.
//   readonly → read-only.
//   edit     → workspace-write: writes inside the worktree, addDirs and temp only, no network
//              (safer than claude's edit, which lets npm reach the registry). The worktree's git
//              directory is in the main checkout, outside the sandbox, so the agent's own commits
//              may fail; settle() in git.ts commits what it leaves.
//   full     → danger-full-access, no sandbox. ALWAYS_DENY cannot be expressed: prefer edit.
// Sandbox and approvals are set with -c (exec resume takes no --sandbox or --cd). The house rules
// go in as developer_instructions; a schema goes to --output-schema, made strict the way the
// Responses API wants it. There is no turn or budget cap in the CLI: maxTurns is enforced here by
// counting tool calls and stopping the run. --ignore-user-config keeps ~/.codex/config.toml (its
// MCP servers and profiles) out of the run; the login in CODEX_HOME still applies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv, registerRunner, type AgentRunner, type RunEvent, type RunResult, type RunSpec } from "./index.ts";
import { clip, extractJson, spawnCli } from "./util.ts";

const BIN = process.env.CODEX_BIN || "codex";
const DEFAULT_MODEL = process.env.CODEX_MODEL || "";
const USER_CONFIG = process.env.CODEX_USER_CONFIG === "1";

type Item = {
  id?: string; type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null; status?: string;
  changes?: Array<{ path?: string; kind?: string }>; server?: string; tool?: string; arguments?: unknown; result?: unknown; error?: unknown; query?: string;
  items?: Array<{ text?: string; completed?: boolean }>; message?: string;
};
type Usage = { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
type Msg = { type?: string; thread_id?: string; item?: Item; usage?: Usage; error?: { message?: string }; message?: string };
export type CodexState = { sessionId?: string; model?: string; lastText: string; toolCalls: number; completed: boolean; failed?: string; lastError?: string; usage: Required<Usage>; started: Set<string> };

export const newState = (spec: RunSpec): CodexState => ({
  sessionId: spec.resumeSessionId, model: spec.model || DEFAULT_MODEL || undefined, lastText: "", toolCalls: 0, completed: false, started: new Set(),
  usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
});

/** The Responses API's strict mode wants every property listed in `required` and no extras: optional ones become nullable. */
export function strictSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(strictSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "title" || k === "$schema" || k === "default" || k === "examples") continue;
    out[k] = k === "properties" && v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictSchema(pv)])) : strictSchema(v);
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const props = out.properties as Record<string, Record<string, unknown>>;
    const required = new Set((out.required as string[] | undefined) ?? []);
    for (const [k, v] of Object.entries(props)) {
      if (required.has(k) || !v.type) continue;
      props[k] = { ...v, type: Array.isArray(v.type) ? [...v.type, "null"] : [v.type, "null"], ...(Array.isArray(v.enum) ? { enum: [...v.enum, null] } : {}) };
    }
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

export function buildArgs(spec: RunSpec, schemaFile?: string): string[] {
  const mode = spec.tools?.mode ?? "edit";
  const sandbox = mode === "full" ? "danger-full-access" : mode === "edit" ? "workspace-write" : "read-only";
  const args = spec.resumeSessionId ? ["exec", "resume"] : ["exec"];
  args.push("--json", "--skip-git-repo-check", "-c", `sandbox_mode="${sandbox}"`, "-c", 'approval_policy="never"');
  if (!USER_CONFIG) args.push("--ignore-user-config");
  const model = spec.model || DEFAULT_MODEL;
  if (model) args.push("-m", model);
  if (spec.effort) args.push("-c", `model_reasoning_effort="${spec.effort === "max" ? "xhigh" : spec.effort}"`);
  // A JSON string is a valid TOML basic string, so the house rules arrive verbatim.
  if (spec.systemPrompt) args.push("-c", `developer_instructions=${JSON.stringify(spec.systemPrompt)}`);
  if (schemaFile) args.push("--output-schema", schemaFile);
  if (spec.resumeSessionId) args.push(spec.resumeSessionId);
  else { args.push("-C", spec.cwd); for (const d of spec.addDirs ?? []) args.push("--add-dir", d); }
  args.push("-");
  return args;
}

const errText = (e: unknown) => (typeof e === "string" ? e : e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : e == null ? "" : JSON.stringify(e));

/** Turns one --json line into factory events. Exported for the tests. */
export function parseLine(m: Msg | null, onEvent: (e: RunEvent) => void, state: CodexState): void {
  if (!m || typeof m !== "object") return;
  if (m.type === "thread.started" && m.thread_id) { state.sessionId = m.thread_id; onEvent({ type: "init", sessionId: m.thread_id, model: state.model }); return; }
  if (m.type === "turn.completed") {
    state.completed = true;
    for (const k of Object.keys(state.usage) as Array<keyof Usage>) state.usage[k] += Number(m.usage?.[k] ?? 0);
    return;
  }
  if (m.type === "turn.failed") { state.failed = m.error?.message || "turn failed"; return; }
  if (m.type === "error") { state.lastError = m.message ?? errText(m.error); onEvent({ type: "log", level: "warn", message: state.lastError.slice(0, 2000) }); return; }
  const it = m.item;
  if (!it || (m.type !== "item.started" && m.type !== "item.completed")) return;
  const id = it.id;
  const use = (name: string, input: unknown) => { if (id && state.started.has(id)) return; if (id) state.started.add(id); onEvent({ type: "tool_use", name, input, id }); };
  const changes = () => (it.changes ?? []).map((c) => `${c.kind ?? "update"} ${c.path ?? "?"}`).join(", ");
  if (m.type === "item.started") {
    if (it.type === "command_execution") use("Bash", { command: it.command });
    else if (it.type === "mcp_tool_call") use(`mcp:${it.server ?? "?"}.${it.tool ?? "?"}`, it.arguments);
    else if (it.type === "web_search") use("WebSearch", { query: it.query });
    return;
  }
  if (it.type === "agent_message") { if (it.text) { state.lastText = it.text; onEvent({ type: "text", text: it.text }); } }
  else if (it.type === "reasoning") { if (it.text) onEvent({ type: "log", level: "info", message: it.text.slice(0, 2000) }); }
  else if (it.type === "command_execution") {
    use("Bash", { command: it.command });
    state.toolCalls++;
    onEvent({ type: "tool_result", id, output: clip(it.aggregated_output ?? ""), isError: it.status === "failed" || (it.exit_code ?? 0) !== 0 });
  } else if (it.type === "file_change") {
    use("Edit", { file_path: changes(), changes: it.changes });
    state.toolCalls++;
    onEvent({ type: "tool_result", id, output: changes(), isError: it.status === "failed" });
  } else if (it.type === "mcp_tool_call") {
    use(`mcp:${it.server ?? "?"}.${it.tool ?? "?"}`, it.arguments);
    state.toolCalls++;
    onEvent({ type: "tool_result", id, output: clip(it.error ? errText(it.error) : typeof it.result === "string" ? it.result : JSON.stringify(it.result ?? "")), isError: Boolean(it.error) || it.status === "failed" });
  } else if (it.type === "web_search") { use("WebSearch", { query: it.query }); state.toolCalls++; }
  else if (it.type === "todo_list") onEvent({ type: "log", level: "info", message: `plan: ${(it.items ?? []).map((x) => `${x.completed ? "[x]" : "[ ]"} ${x.text ?? ""}`).join("; ")}`.slice(0, 2000) });
  else if (it.type === "error") onEvent({ type: "log", level: "warn", message: (it.message ?? "").slice(0, 2000) });
}

export const codexRunner: AgentRunner = {
  id: "codex",
  label: "OpenAI Codex (codex exec)",
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
    const tmp = spec.schema ? fs.mkdtempSync(path.join(os.tmpdir(), "factory-codex-")) : null;
    const schemaFile = tmp ? path.join(tmp, "schema.json") : undefined;
    if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(strictSchema(spec.schema)));
    const state = newState(spec);
    try {
      const x = await spawnCli({
        bin: BIN, args: buildArgs(spec, schemaFile), cwd: spec.cwd, env: childEnv(spec.env, { agent: true }), input: spec.prompt, timeoutMs: spec.timeoutMs, signal,
        onLine: (obj, raw, stop) => {
          if (obj == null) { if (raw.trim()) onEvent({ type: "log", level: "info", message: raw.slice(0, 2000) }); return; }
          parseLine(obj as Msg, onEvent, state);
          if (spec.maxTurns && state.toolCalls > spec.maxTurns) stop("error_max_turns");
        },
      });
      const turns = state.toolCalls + (state.completed ? 1 : 0);
      const base = { sessionId: state.sessionId, result: state.lastText, turns, usage: state.usage, durationMs: x.durationMs, exitCode: x.code, stderr: x.stderr };
      if (x.killedBy) return { ...base, ok: false, error: x.killedBy };
      if (x.code !== 0 || state.failed || !state.completed) {
        const why = state.failed ?? state.lastError ?? (x.stderr.trim().split("\n").pop() || "");
        return { ...base, ok: false, error: `${state.failed ? "error_during_execution" : `exit ${x.code}`}${why ? `: ${why.slice(0, 300)}` : ""}` };
      }
      if (!spec.schema) return { ...base, ok: true };
      const structured = extractJson(state.lastText);
      return structured ? { ...base, ok: true, structured } : { ...base, ok: false, error: "no structured answer: the final message held no JSON object" };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
};

export function register(): void { registerRunner(codexRunner); }
