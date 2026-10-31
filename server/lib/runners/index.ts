// The adapter between the factory and whichever coding agent does the work.
//
// Today that is the claude CLI on this Mac's subscription login; the same interface fits
// `codex exec`, the Gemini CLI, or an API-backed agent later. A runner is handed a working
// directory, a prompt, limits and a tool policy; it streams events back and ends with a result
// that says whether it succeeded, what it cost, and a session id that can be resumed with
// follow-up feedback ("the reviewer said X — fix it").

export type ToolMode = "none" | "readonly" | "edit" | "full";

export type RunSpec = {
  cwd: string;
  prompt: string;
  /** Appended to the runner's own system prompt: the factory's house rules for this run. */
  systemPrompt?: string;
  model?: string;
  fallbackModel?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  tools?: { mode: ToolMode; allow?: string[]; deny?: string[] };
  /** JSON schema for a structured answer (plan, triage, note). */
  schema?: object;
  /** Continue an earlier session of the same runner. */
  resumeSessionId?: string;
  /** Pin the id of a new session so it can be resumed later even if the result is lost. */
  sessionId?: string;
  addDirs?: string[];
  env?: Record<string, string>;
  /** Extra MCP servers (JSON config) the runner may load, if it supports them. */
  mcpConfig?: string;
};

export type RunEvent =
  | { type: "init"; sessionId: string; model?: string; tools?: string[] }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown; id?: string }
  | { type: "tool_result"; id?: string; output: string; isError?: boolean }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  /** Plan usage as the CLI reports it (0–1 of each window); the factory throttles on it. */
  | { type: "usage"; fiveHour?: number; sevenDay?: number; resetsAt?: number; status?: string; raw?: unknown }
  /** The agent asked for something the policy did not allow. */
  | { type: "denied"; tool: string; message?: string };

export type RunResult = {
  ok: boolean;
  sessionId?: string;
  /** The final text the agent wrote. */
  result?: string;
  /** The structured answer when a schema was given. */
  structured?: unknown;
  costUsd?: number;
  turns?: number;
  usage?: unknown;
  durationMs: number;
  exitCode: number | null;
  /** Why it failed: the runner's own subtype (error_max_turns, budget, timeout, cancelled…). */
  error?: string;
  denials?: unknown[];
  stderr?: string;
};

export type Capabilities = { resume: boolean; structuredOutput: boolean; tools: boolean; costReporting: boolean; budget: boolean };

export interface AgentRunner {
  id: string;
  label: string;
  capabilities: Capabilities;
  /** Is the binary there and signed in? For the Settings page. */
  check(): Promise<{ ok: boolean; version?: string; detail?: string }>;
  run(spec: RunSpec, onEvent: (e: RunEvent) => void, signal: AbortSignal): Promise<RunResult>;
}

const registry = new Map<string, AgentRunner>();
export function registerRunner(r: AgentRunner): void { registry.set(r.id, r); }
export function getRunner(id: string | null | undefined): AgentRunner {
  const r = registry.get(id || process.env.RUNNER || "claude");
  if (!r) throw new Error(`no runner "${id}" (have: ${[...registry.keys()].join(", ")})`);
  return r;
}
export const listRunners = () => [...registry.values()];

/**
 * A child's environment: PATH and HOME so the CLI finds itself and its login, nothing of ours (no
 * database URL, no OAuth secret, no tokens). For an agent (`agent: true`) the SSH agent socket and
 * GitHub tokens are left out as well: the factory pushes and opens pull requests, the agent does not.
 */
export function childEnv(extra: Record<string, string> = {}, opts: { agent?: boolean } = {}): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "NVM_DIR", "GOPATH", "GOROOT", "JAVA_HOME", "ANDROID_HOME"];
  if (!opts.agent) keep.push("SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN");
  // Provider credentials are never inherited by accident: an operator who wants API billing or a
  // cloud account lists the variables in CLAUDE_ENV_PASSTHROUGH (e.g. ANTHROPIC_API_KEY).
  for (const k of (process.env.CLAUDE_ENV_PASSTHROUGH || "").split(",").map((x) => x.trim()).filter(Boolean)) keep.push(k);
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  env.TERM = env.TERM || "dumb";
  env.CI = "1";
  // Every git the factory or the agent runs (gh's own included): no repository hooks, no fsmonitor daemon.
  env.GIT_CONFIG_PARAMETERS = "'core.hooksPath=/dev/null' 'core.fsmonitor=false'";
  if (opts.agent) {
    // No stored git credentials, no gh login, no ssh keys, no prompts: the agent can read and commit, the factory pushes.
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_SSH_COMMAND = "ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o IdentityAgent=none";
    env.GH_CONFIG_DIR = emptyDir();
    env.GH_NO_UPDATE_NOTIFIER = "1";
    env.NPM_CONFIG_USERCONFIG = "/dev/null"; // no publish tokens from ~/.npmrc
    env.NETRC = "/dev/null";
  }
  env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || "Software Factory";
  env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || "factory@localhost";
  env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
  return { ...env, ...extra };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

let empty: string | null = null;
/** An empty, factory-owned directory handed to tools as their config home, so they find no login there. */
function emptyDir(): string {
  if (!empty) { empty = path.join(os.tmpdir(), "factory-empty-config"); fs.mkdirSync(empty, { recursive: true }); }
  return empty;
}

const children = new Set<ChildProcess>();
export const trackChild = (c: ChildProcess) => { children.add(c); c.once("exit", () => children.delete(c)); };
/** SIGTERM to the whole process group (children are spawned detached as group leaders), SIGKILL after a grace period. */
export function killTree(c: ChildProcess, graceMs = 5000): void {
  const sig = (name: NodeJS.Signals) => { if (!c.pid) return; try { process.kill(-c.pid, name); } catch { try { c.kill(name); } catch { /* gone */ } } };
  sig("SIGTERM");
  setTimeout(() => sig("SIGKILL"), graceMs).unref();
}
export function killAllChildren(): void { for (const c of children) killTree(c, 2000); }

/** Reads newline-delimited JSON off a stream, tolerating partial chunks. */
export function ndjson(onLine: (obj: unknown, raw: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buf = "";
  const handle = (line: string) => {
    const t = line.trim();
    if (!t) return;
    try { onLine(JSON.parse(t), t); } catch { onLine(null, t); }
  };
  return {
    push(chunk) { buf += chunk; let i; while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } },
    flush() { if (buf.trim()) handle(buf); buf = ""; },
  };
}
