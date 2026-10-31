// Running things: git, the project's own test/build/deploy commands, gh. Output is captured
// (and optionally streamed), there is always a timeout, and a child is never left behind.
import { spawn } from "node:child_process";
import { childEnv, killTree, trackChild } from "./runners/index.ts";

export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number };

export type RunOpts = { cwd?: string; env?: Record<string, string>; timeoutMs?: number; onOutput?: (chunk: string, stream: "stdout" | "stderr") => void; input?: string; signal?: AbortSignal; maxOutput?: number; /** Run with the agent's credential-free environment (project commands run code the agent wrote). */ agent?: boolean };

export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const max = opts.maxOutput ?? 200_000;
    let stdout = "", stderr = "", timedOut = false, done = false;
    // Its own process group, so a timeout takes the grandchildren (a test runner that would hold the pipes open) with it.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: childEnv(opts.env, { agent: opts.agent }), stdio: ["pipe", "pipe", "pipe"], detached: true });
    trackChild(child);
    const keep = (s: string, d: string) => (s.length + d.length > max ? (s + d).slice(-max) : s + d);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { stdout = keep(stdout, d); opts.onOutput?.(d, "stdout"); });
    child.stderr.on("data", (d: string) => { stderr = keep(stderr, d); opts.onOutput?.(d, "stderr"); });
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started }); };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs ?? 10 * 60 * 1000);
    const onAbort = () => { timedOut = true; killTree(child); };
    if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => { stderr += `\n${e.message}`; });
    child.on("close", (code) => finish(code));
    // A stray grandchild can keep the pipes open after the child is gone: do not wait for it forever.
    child.on("exit", (code) => { setTimeout(() => finish(code), 2000).unref(); });
    child.stdin.on("error", () => {});
    if (opts.input != null) child.stdin.end(opts.input); else child.stdin.end();
  });
}

/** A project's own command (`npm test`, `make deploy`) in a plain (non-login) shell, with the agent's environment, since it runs what the agent wrote. */
export function shell(command: string, opts: RunOpts = {}): Promise<ExecResult> {
  // Not a login shell: the user's profile would put tokens and the SSH agent back into an environment that was emptied on purpose.
  const sh = process.env.SHELL && /zsh|bash/.test(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
  return run(sh, ["-c", command], { agent: true, ...opts });
}

/** What every factory git call carries: no hooks, no fsmonitor daemon, no signing — nothing the repository (which the agent writes) can hook into. */
export const GIT_SAFE = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat"];

/** A factory git call that reports instead of throwing. */
export function gitq(args: string[], opts: RunOpts & { cwd: string }): Promise<ExecResult> {
  return run("git", [...GIT_SAFE, ...args], opts);
}

/** The factory's own git: hooks the repository may carry (which the agent could have written) never run here. */
export async function git(args: string[], cwd: string, opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
  const r = await run("git", [...GIT_SAFE, ...args], { cwd, timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000, env: opts.env });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.timedOut ? "timeout" : r.code}): ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  return r.stdout.trimEnd();
}

export const tail = (s: string, n = 6000) => (s.length > n ? `… (${s.length - n} more characters)\n${s.slice(-n)}` : s);
