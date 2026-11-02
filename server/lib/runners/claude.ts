// The claude CLI (`claude -p`) on this Mac's subscription login, driven headless.
//
// Output is stream-json, one event per line: the init (session id, model), every assistant
// message (text and tool calls), every tool result, and a final result with cost and usage.
// Permissions never prompt: the tool policy is turned into --permission-mode plus allow and
// deny lists, and --permission-prompts none denies anything else outright. Only the repo's own
// settings apply (--setting-sources project); this Mac's user settings, hooks and MCP servers
// stay out of the run.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv, killTree, ndjson, trackChild, type AgentRunner, type RunEvent, type RunResult, type RunSpec } from "./index.ts";

const BIN = process.env.CLAUDE_BIN || "claude";
export const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
export const SMALL_MODEL = process.env.CLAUDE_SMALL_MODEL || "claude-sonnet-5-5";
const FALLBACK = process.env.CLAUDE_FALLBACK_MODEL || "";
const SETTING_SOURCES = process.env.CLAUDE_SETTING_SOURCES || "project";

/** Read-only exploration: look, do not touch. */
// Looking only: no `find -exec`, no `rg --pre`, no `git branch -D`; the Grep and Glob tools cover searching.
export const READONLY_ALLOW = [
  "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git status:*)", "Bash(git blame:*)", "Bash(git rev-parse:*)", "Bash(git ls-files:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(grep:*)", "Bash(tree:*)", "Bash(pwd)", "Bash(which:*)", "Bash(file:*)",
];
/** Building: the toolchain, git inside the worktree, the usual file commands. Pushing, the network, the machine itself: no. */
export const EDIT_ALLOW = [
  ...READONLY_ALLOW,
  "Bash(git add:*)", "Bash(git commit:*)", "Bash(git restore:*)", "Bash(git stash:*)", "Bash(git mv:*)", "Bash(git rm:*)", "Bash(git checkout -- :*)",
  "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(pnpm:*)", "Bash(yarn:*)", "Bash(bun:*)", "Bash(tsc:*)", "Bash(vitest:*)", "Bash(jest:*)", "Bash(eslint:*)", "Bash(prettier:*)",
  "Bash(make:*)", "Bash(go:*)", "Bash(gofmt:*)", "Bash(cargo:*)", "Bash(rustc:*)", "Bash(python3:*)", "Bash(python:*)", "Bash(pip:*)", "Bash(pip3:*)", "Bash(pytest:*)", "Bash(uv:*)", "Bash(ruby:*)", "Bash(bundle:*)", "Bash(swift:*)", "Bash(xcodebuild:*)", "Bash(mvn:*)", "Bash(gradle:*)", "Bash(./gradlew:*)", "Bash(dotnet:*)",
  "Bash(mkdir:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)", "Bash(sed:*)", "Bash(awk:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(cut:*)", "Bash(diff:*)", "Bash(echo:*)", "Bash(printf:*)", "Bash(env)", "Bash(date:*)", "Bash(sleep:*)", "Bash(chmod:*)", "Bash(jq:*)",
  "Bash(find:*)", "Bash(rg:*)",
];
/** Never, whatever a project allows: pushing, git's config, other users, and the shells that would hide a command from these rules. */
export const NEVER_DENY = [
  "Bash(git push:*)", "Bash(git push)", "Bash(git remote:*)", "Bash(git config --global:*)", "Bash(git config:*)", "Bash(gh:*)", "Bash(sudo:*)", "Bash(su:*)", "Bash(rm -rf /:*)", "Bash(rm -rf ~:*)", "Bash(rm -rf $HOME:*)",
  "Bash(sh -c:*)", "Bash(bash -c:*)", "Bash(zsh -c:*)", "Bash(xargs:*)", "Bash(eval:*)",
];
/** Off by default: the network, other machines, this one's services. A project that allows the same command (Bash(kubectl get:*)) lifts its entry. */
export const DEFAULT_DENY = [
  "Bash(nohup:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(launchctl:*)", "Bash(kill:*)", "Bash(pkill:*)", "Bash(killall:*)", "Bash(ssh:*)", "Bash(scp:*)", "Bash(rsync:*)", "Bash(open:*)", "Bash(osascript:*)",
  "Bash(crontab:*)", "Bash(docker:*)", "Bash(kubectl:*)", "Bash(brew:*)", "Bash(defaults:*)", "Bash(security:*)",
];
export const ALWAYS_DENY = [...NEVER_DENY, ...DEFAULT_DENY];

const command = (rule: string) => /^Bash\(([^\s:)]+)/.exec(rule)?.[1] ?? null;
/** The deny list for a run: the defaults minus what the project allows by name, plus the project's own. */
export function denyFor(allow: string[], deny: string[]): string[] {
  const allowed = new Set(allow.map(command).filter(Boolean));
  return [...NEVER_DENY, ...DEFAULT_DENY.filter((d) => !allowed.has(command(d))), ...deny];
}
/** A folder the agent may read (not write) outside its worktree; `//` marks an absolute path in a permission rule. */
export const readRule = (dir: string) => `Read(/${dir.replace(/\/+$/, "")}/**)`;

type Msg = {
  type?: string; subtype?: string; session_id?: string; model?: string; tools?: string[]; apiKeySource?: string; message?: { content?: unknown }; is_error?: boolean; result?: string; structured_output?: unknown;
  total_cost_usd?: number; num_turns?: number; usage?: unknown; modelUsage?: unknown; duration_ms?: number; permission_denials?: unknown[]; error?: string; api_error_status?: number;
  tool_name?: string; tool_use_id?: string; decision_reason?: string; attempt?: number; max_retries?: number; error_status?: number;
  rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string; isUsingOverage?: boolean; unifiedWindows?: { five_hour?: { utilization?: number; resetsAt?: number; status?: string }; seven_day?: { utilization?: number; resetsAt?: number; status?: string } } };
};

function toolArgs(spec: RunSpec): string[] {
  const mode = spec.tools?.mode ?? "edit";
  // Granting a folder or an MCP server means letting the agent use it: neither would ever be approved otherwise.
  const allow = [...(spec.tools?.allow ?? []), ...(spec.readDirs ?? []).map(readRule), ...Object.keys(spec.mcp ?? {}).map((n) => `mcp__${n}`)];
  const deny = denyFor(allow, spec.tools?.deny ?? []);
  const args: string[] = ["--permission-prompts", "none"];
  if (mode === "none") return ["--tools", ""];
  // The web tools only when the project allows them: offered and always refused, they cost a turn each.
  const web = ["WebFetch", "WebSearch"].filter((t) => allow.some((a) => a === t || a.startsWith(`${t}(`)));
  if (mode === "readonly") args.push("--tools", ["Read", "Grep", "Glob", "Bash", ...web].join(","), "--permission-mode", "dontAsk", "--allowedTools", ...READONLY_ALLOW, ...allow, "--disallowedTools", ...deny, "Edit", "Write", "NotebookEdit");
  else if (mode === "edit") args.push("--permission-mode", "acceptEdits", "--allowedTools", ...EDIT_ALLOW, ...allow, "--disallowedTools", ...deny);
  else args.push("--dangerously-skip-permissions", "--disallowedTools", ...deny);
  return args;
}

export function buildArgs(spec: RunSpec): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", SETTING_SOURCES, "--strict-mcp-config", "--no-chrome"];
  // Inline: the CLI fills in ${NAME} from the run's environment, so keys stay in the project's environment, not here.
  if (spec.mcp && Object.keys(spec.mcp).length) args.push("--mcp-config", JSON.stringify({ mcpServers: spec.mcp }));
  args.push("--model", spec.model || DEFAULT_MODEL);
  const fb = spec.fallbackModel ?? FALLBACK;
  if (fb) args.push("--fallback-model", fb);
  if (spec.effort) args.push("--effort", spec.effort);
  if (spec.maxTurns) args.push("--max-turns", String(spec.maxTurns));
  if (spec.maxBudgetUsd) args.push("--max-budget-usd", String(spec.maxBudgetUsd));
  if (spec.schema) args.push("--json-schema", JSON.stringify(spec.schema));
  if (spec.systemPrompt) args.push("--append-system-prompt", spec.systemPrompt);
  for (const d of spec.addDirs ?? []) args.push("--add-dir", d);
  if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
  else args.push("--session-id", spec.sessionId || randomUUID());
  args.push(...toolArgs(spec));
  return args;
}

/** Turns one stream-json line into factory events. Exported for the tests. */
export function parseLine(m: Msg | null, onEvent: (e: RunEvent) => void, state: { sessionId?: string; lastText: string; result?: Msg }): void {
  if (!m || typeof m !== "object") return;
  if (m.type === "system") {
    if (m.subtype === "init") {
      state.sessionId = m.session_id;
      onEvent({ type: "init", sessionId: m.session_id ?? "", model: m.model, tools: m.tools });
      if (m.apiKeySource && m.apiKeySource !== "none") onEvent({ type: "log", level: "warn", message: `this run authenticates with ${m.apiKeySource}, not the subscription login` });
    } else if (m.subtype === "permission_denied") onEvent({ type: "denied", tool: m.tool_name ?? "?", id: m.tool_use_id, message: m.message as unknown as string | undefined ?? m.decision_reason });
    else if (m.subtype === "api_retry") onEvent({ type: "log", level: "warn", message: `API retry ${m.attempt ?? "?"}/${m.max_retries ?? "?"}: ${m.error ?? ""} ${m.error_status ?? ""}`.trim() });
    return;
  }
  if (m.type === "rate_limit_event" && m.rate_limit_info) {
    const w = m.rate_limit_info.unifiedWindows;
    onEvent({ type: "usage", fiveHour: w?.five_hour?.utilization, sevenDay: w?.seven_day?.utilization, resetsAt: w?.five_hour?.resetsAt ?? m.rate_limit_info.resetsAt, status: m.rate_limit_info.status, raw: m.rate_limit_info });
    return;
  }
  if (m.type === "assistant") {
    const blocks = Array.isArray(m.message?.content) ? (m.message!.content as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>) : [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) { state.lastText = b.text; onEvent({ type: "text", text: b.text }); }
      else if (b.type === "tool_use") onEvent({ type: "tool_use", name: b.name ?? "?", input: b.input, id: b.id });
    }
    return;
  }
  if (m.type === "user") {
    const blocks = Array.isArray(m.message?.content) ? (m.message!.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) : [];
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const c = b.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : "")).join("\n") : "";
      onEvent({ type: "tool_result", id: b.tool_use_id, output: text.length > 4000 ? `${text.slice(0, 4000)}\n… (${text.length - 4000} more characters)` : text, isError: b.is_error });
    }
    return;
  }
  if (m.type === "result") { state.result = m; if (m.session_id) state.sessionId = m.session_id; }
}

export const claudeRunner: AgentRunner = {
  id: "claude",
  label: "Claude Code (claude -p)",
  capabilities: { resume: true, structuredOutput: true, tools: true, costReporting: true, budget: true },

  async check() {
    try {
      const { stdout } = await promisify(execFile)(BIN, ["--version"], { env: childEnv(), timeout: 15000 });
      return { ok: true, version: stdout.trim(), detail: BIN };
    } catch (e) {
      return { ok: false, detail: `${BIN}: ${e instanceof Error ? e.message : String(e)}` };
    }
  },

  run(spec, onEvent, signal) {
    return new Promise<RunResult>((resolve) => {
      const args = buildArgs(spec);
      const env = childEnv(spec.env, { agent: true });
      delete env.CLAUDECODE;
      const started = Date.now();
      const state: { sessionId?: string; lastText: string; result?: Msg } = { lastText: "", sessionId: spec.resumeSessionId ?? args[args.indexOf("--session-id") + 1] };
      let stderr = "";
      let killedBy: string | null = null;
      const child = spawn(BIN, args, { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      trackChild(child);
      const reader = ndjson((obj, raw) => {
        if (obj == null) { if (raw.trim()) onEvent({ type: "log", level: "info", message: raw.slice(0, 2000) }); return; }
        parseLine(obj as Msg, onEvent, state);
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => reader.push(d));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
      const stop = (why: string) => {
        if (killedBy) return;
        killedBy = why;
        killTree(child);
      };
      const timer = setTimeout(() => stop("timeout"), spec.timeoutMs ?? 60 * 60 * 1000);
      const onAbort = () => stop("cancelled");
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => { stderr += `\n${err.message}`; });
      let finished = false;
      // A grandchild holding the pipes must not keep the run open forever: resolve shortly after the CLI itself exits.
      child.on("exit", (code) => { setTimeout(() => { if (!finished) child.emit("close", code); }, 2000).unref(); });
      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reader.flush();
        const r = state.result;
        const durationMs = Date.now() - started;
        if (killedBy) return resolve({ ok: false, sessionId: state.sessionId, result: state.lastText, durationMs, exitCode: code, error: killedBy, stderr: stderr.slice(-4000) });
        if (!r) return resolve({ ok: false, sessionId: state.sessionId, result: state.lastText, durationMs, exitCode: code, error: `no result (exit ${code})`, stderr: stderr.slice(-4000) });
        const ok = !r.is_error && (r.subtype === "success" || !r.subtype);
        resolve({
          ok, sessionId: state.sessionId, result: r.result ?? state.lastText, structured: r.structured_output,
          costUsd: r.total_cost_usd, turns: r.num_turns, usage: { usage: r.usage, modelUsage: r.modelUsage }, durationMs: r.duration_ms ?? durationMs, exitCode: code,
          error: ok ? undefined : `${r.subtype ?? "error"}${r.api_error_status ? ` (HTTP ${r.api_error_status})` : ""}${r.error ? `: ${r.error}` : ""}${(!r.subtype || r.subtype === "error_during_execution") && r.result ? `: ${String(r.result).slice(0, 300)}` : ""}`,
          denials: r.permission_denials, stderr: stderr.slice(-4000),
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(spec.prompt);
    });
  },
};
