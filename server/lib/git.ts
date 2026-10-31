// A project is a git repository: one the factory cloned, or one already on this Mac. Every
// job gets its own worktree on its own branch, so jobs never see each other's half-done
// work and the live checkout of a local project is never touched. When the job is done the
// branch is pushed and a pull request opened (delivery "pr"), or merged into the default
// branch of the local checkout (delivery "local").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitq, run, shell } from "./exec.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA = process.env.FACTORY_DATA ? path.resolve(process.env.FACTORY_DATA) : path.join(ROOT, "data");
export const REPOS = path.join(DATA, "repos");
export const WORK = path.join(DATA, "work");

// git takes locks on the repository (index, config, refs); two jobs creating worktrees at once trip
// over each other. Everything that touches the shared repository goes through its lock.
const locks = new Map<string, Promise<unknown>>();
export function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.resolve(key.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
  const prev = locks.get(dir) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(dir, next);
  next.finally(() => { if (locks.get(dir) === next) locks.delete(dir); }).catch(() => {});
  return next;
}

export type RepoProject = { id: number; slug: string; repo_url: string | null; local_path: string | null; default_branch: string; setup_command: string | null; env?: Record<string, string> };

/** Where the project's main checkout lives: its own path, or our clone of it. */
export function repoDir(p: RepoProject): string {
  if (p.local_path) return p.local_path.replace(/^~(?=$|\/)/, process.env.HOME || "~");
  return path.join(REPOS, p.slug);
}

export async function hasRemote(dir: string): Promise<boolean> {
  const r = await gitq(["remote"], { cwd: dir, timeoutMs: 20000 });
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** Clone if needed, then fetch, so the base of a new job is what the remote has now. */
export async function ensureRepo(p: RepoProject, onLog?: (m: string) => void): Promise<string> {
  const dir = repoDir(p);
  if (p.local_path) {
    if (!fs.existsSync(dir)) throw new Error(`local path ${dir} does not exist`);
    // .git is a directory in a checkout and a file in a worktree; without it git would work on whatever repository encloses the path.
    if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`local path ${dir} is not a git repository (no .git at its root)`);
    if (await hasRemote(dir)) { onLog?.(`fetching ${dir}`); await gitq(["fetch", "--prune", "--quiet"], { cwd: dir, timeoutMs: 120000 }); }
    return dir;
  }
  if (!p.repo_url) throw new Error("project has neither a repo URL nor a local path");
  fs.mkdirSync(REPOS, { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    onLog?.(`cloning ${p.repo_url}`);
    await git(["clone", "--quiet", p.repo_url, dir], REPOS, { timeoutMs: 15 * 60 * 1000 });
  } else {
    onLog?.(`fetching ${p.repo_url}`);
    await git(["fetch", "--prune", "--quiet"], dir, { timeoutMs: 120000 });
  }
  return dir;
}

/** The commit a new job starts from: the remote's default branch when there is a remote, else the local one. */
export async function baseRef(dir: string, defaultBranch: string): Promise<string> {
  if (await hasRemote(dir)) {
    const r = await gitq(["rev-parse", "--verify", "--quiet", `origin/${defaultBranch}`], { cwd: dir, timeoutMs: 20000 });
    if (r.code === 0) return `origin/${defaultBranch}`;
  }
  return defaultBranch;
}

export const branchName = (itemId: number, title: string) => `factory/${itemId}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "job"}`;

export async function createWorktree(p: RepoProject, itemId: number, branch: string, onLog?: (m: string) => void, opts: { reuseBranch?: boolean; baseSha?: string | null } = {}): Promise<{ worktree: string; baseSha: string }> {
  const made = await withRepoLock(repoDir(p), () => createWorktreeNow(p, itemId, branch, onLog, opts));
  // The setup (npm ci can take minutes) runs outside the lock: it only touches this worktree.
  if (p.setup_command) {
    onLog?.(`setup: ${p.setup_command}`);
    const r = await shell(p.setup_command, { cwd: made.worktree, timeoutMs: 15 * 60 * 1000, env: p.env });
    if (r.code !== 0) throw new Error(`setup command failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-1500)}`);
  }
  return made;
}

async function createWorktreeNow(p: RepoProject, itemId: number, branch: string, onLog?: (m: string) => void, opts: { reuseBranch?: boolean; baseSha?: string | null } = {}): Promise<{ worktree: string; baseSha: string }> {
  const dir = await ensureRepo(p, onLog);
  const worktree = path.join(WORK, p.slug, String(itemId));
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  if (fs.existsSync(worktree)) await removeWorktreeNow(dir, worktree); // already under the lock
  await gitq(["worktree", "prune"], { cwd: dir, timeoutMs: 60000 });
  const exists = (await gitq(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: dir, timeoutMs: 20000 })).code === 0;
  let baseSha: string;
  if (opts.reuseBranch && exists) {
    // A retry: the branch already carries commits from an earlier attempt; keep them.
    baseSha = opts.baseSha || (await git(["merge-base", branch, await baseRef(dir, p.default_branch)], dir));
    await git(["worktree", "add", "--quiet", worktree, branch], dir);
    onLog?.(`worktree ${worktree} on existing branch ${branch} (base ${baseSha.slice(0, 7)})`);
  } else {
    const base = await baseRef(dir, p.default_branch);
    baseSha = await git(["rev-parse", base], dir);
    if (exists) await gitq(["branch", "-D", branch], { cwd: dir, timeoutMs: 20000 }); // a leftover from an earlier attempt
    await git(["worktree", "add", "--quiet", "-b", branch, worktree, base], dir);
    onLog?.(`worktree ${worktree} on ${branch} from ${base} (${baseSha.slice(0, 7)})`);
  }
  return { worktree, baseSha };
}

export function removeWorktree(repo: string, worktree: string): Promise<void> {
  return withRepoLock(repo, () => removeWorktreeNow(repo, worktree));
}
async function removeWorktreeNow(repo: string, worktree: string): Promise<void> {
  await gitq(["worktree", "remove", "--force", worktree], { cwd: repo, timeoutMs: 60000 });
  if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
  await gitq(["worktree", "prune"], { cwd: repo, timeoutMs: 60000 });
}

/** What the agent left behind: commits on the branch, and anything it did not commit (which we commit for it). */
export async function settle(worktree: string, baseSha: string, message: string): Promise<{ headSha: string; commits: number; committedForAgent: boolean; files: string[] }> {
  // A merge the agent resolved but did not commit is finished for it; one with conflicts left is abandoned, never committed with its markers.
  const gitDir = path.resolve(worktree, await git(["rev-parse", "--git-dir"], worktree));
  if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    const unmerged = (await gitq(["diff", "--name-only", "--diff-filter=U"], { cwd: worktree, timeoutMs: 60000 })).stdout.trim();
    if (unmerged) await gitq(["merge", "--abort"], { cwd: worktree, timeoutMs: 60000 });
    else { await gitq(["add", "-A"], { cwd: worktree, timeoutMs: 60000 }); await gitq(["commit", "--quiet", "--no-edit"], { cwd: worktree, timeoutMs: 60000 }); }
  }
  const status = await git(["status", "--porcelain"], worktree);
  let committedForAgent = false;
  if (status.trim()) {
    await git(["add", "-A"], worktree);
    await git(["commit", "--quiet", "-m", message], worktree);
    committedForAgent = true;
  }
  const headSha = await git(["rev-parse", "HEAD"], worktree);
  const commits = headSha === baseSha ? 0 : Number((await git(["rev-list", "--count", `${baseSha}..HEAD`], worktree)) || 0);
  const files = commits ? (await git(["diff", "--name-only", `${baseSha}..HEAD`], worktree)).split("\n").filter(Boolean) : [];
  return { headSha, commits, committedForAgent, files };
}

export async function diff(worktree: string, baseSha: string, maxBytes = 400_000): Promise<{ stat: string; patch: string; truncated: boolean }> {
  const stat = await git(["diff", "--stat", `${baseSha}..HEAD`], worktree).catch(() => "");
  const r = await gitq(["diff", `${baseSha}..HEAD`], { cwd: worktree, timeoutMs: 60000, maxOutput: maxBytes });
  return { stat, patch: r.stdout, truncated: r.stdout.length >= maxBytes };
}

export async function commitLog(worktree: string, baseSha: string): Promise<string> {
  return git(["log", "--format=%h %s", `${baseSha}..HEAD`], worktree).catch(() => "");
}

export async function push(worktree: string, branch: string): Promise<void> {
  await git(["push", "--force-with-lease", "-u", "origin", branch], worktree, { timeoutMs: 5 * 60 * 1000 });
}

/** The GitHub repository behind a remote, for gh and for reading reviews back. */
export async function githubRepo(dir: string): Promise<string | null> {
  const r = await gitq(["remote", "get-url", "origin"], { cwd: dir, timeoutMs: 20000 });
  if (r.code !== 0) return null;
  const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(r.stdout.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function openPr(worktree: string, base: string, title: string, bodyText: string): Promise<{ url: string; number: number | null }> {
  const r = await run("gh", ["pr", "create", "--base", base, "--title", title.slice(0, 250), "--body-file", "-"], { cwd: worktree, timeoutMs: 120000, input: bodyText });
  if (r.code !== 0) {
    // Already open for this branch? Then report that one.
    const v = await run("gh", ["pr", "view", "--json", "url,number"], { cwd: worktree, timeoutMs: 60000 });
    if (v.code === 0) { try { const j = JSON.parse(v.stdout); return { url: j.url, number: j.number }; } catch { /* fall through */ } }
    throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim().slice(-1500)}`);
  }
  const url = r.stdout.trim().split("\n").pop() ?? "";
  const num = /\/pull\/(\d+)/.exec(url);
  return { url, number: num ? Number(num[1]) : null };
}

export async function mergePr(worktree: string, prNumber: number, method: "squash" | "merge" | "rebase" = "squash", repo?: string | null): Promise<string> {
  const r = await run("gh", ["pr", "merge", String(prNumber), `--${method}`, "--delete-branch", ...(repo ? ["-R", repo] : [])], { cwd: worktree, timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(`gh pr merge failed: ${(r.stderr || r.stdout).trim().slice(-1500)}`);
  return r.stdout.trim();
}

/** Merge the job's branch into the default branch of the local checkout (delivery "local"). Refuses when that checkout is dirty or on another branch. */
export function mergeLocal(p: RepoProject, branch: string, message: string): Promise<{ sha: string }> {
  return withRepoLock(repoDir(p), () => mergeLocalNow(p, branch, message));
}

async function mergeLocalNow(p: RepoProject, branch: string, message: string): Promise<{ sha: string }> {
  const dir = repoDir(p);
  const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (current !== p.default_branch) throw new Error(`the checkout at ${dir} is on ${current}, not ${p.default_branch}; switch it back before merging`);
  const status = await git(["status", "--porcelain", "--untracked-files=no"], dir);
  if (status.trim()) throw new Error(`the checkout at ${dir} has uncommitted changes; commit or stash them before the factory merges`);
  const remote = await hasRemote(dir);
  if (remote) {
    // The remote's default branch may have moved while the job waited in review: land on top of it, not beside it.
    await git(["fetch", "--quiet", "origin"], dir, { timeoutMs: 120000 });
    const r = await gitq(["merge", "--ff-only", `origin/${p.default_branch}`], { cwd: dir, timeoutMs: 60000 });
    if (r.code !== 0) throw new Error(`the checkout at ${dir} has diverged from origin/${p.default_branch}; reconcile it by hand before the factory merges`);
  }
  try {
    await git(["merge", "--no-ff", "--no-edit", "-m", message, branch], dir);
  } catch (e) {
    // Never leave the person's checkout mid-merge with conflict markers in it.
    await gitq(["merge", "--abort"], { cwd: dir, timeoutMs: 60000 });
    throw e;
  }
  const sha = await git(["rev-parse", "HEAD"], dir);
  if (remote) {
    const r = await gitq(["push", "--quiet", "origin", p.default_branch], { cwd: dir, timeoutMs: 5 * 60 * 1000 });
    if (r.code !== 0) throw new Error(`merged locally at ${sha.slice(0, 7)}, but the push to origin/${p.default_branch} failed: ${(r.stderr || r.stdout).trim().slice(-600)}`);
  }
  return { sha };
}

/** For the item page: the files a worktree holds now (so a reviewer can read what the agent wrote without opening a terminal). */
export function readWorktreeFile(worktree: string, rel: string, max = 200_000): string | null {
  const full = path.resolve(worktree, rel);
  if (!full.startsWith(path.resolve(worktree) + path.sep)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  // A symlink the agent (or the repository) left behind must not read outside the worktree.
  if (!fs.realpathSync(full).startsWith(fs.realpathSync(worktree) + path.sep)) return null;
  const buf = fs.readFileSync(full);
  return buf.length > max ? `${buf.subarray(0, max).toString("utf8")}\n… (truncated)` : buf.toString("utf8");
}

/** A real merge conflict, not branch protection or a pending check ("not mergeable" alone is not enough). */
export const isConflict = (e: unknown) => /CONFLICT \(|Merge conflict|conflict in |cannot be cleanly created|CONFLICTING/i.test(e instanceof Error ? e.message : String(e));

/**
 * Brings a job's branch up to date with the base it will land on: fetches, then merges the base
 * into the worktree. Clean → done. Conflicts → the merge is left in progress with the markers in
 * place and the conflicted files are returned, for an agent to resolve and commit.
 */
export async function reconcileWithBase(p: RepoProject, worktree: string): Promise<{ clean: boolean; conflicted: string[]; base: string }> {
  const dir = repoDir(p);
  if (await hasRemote(dir)) await withRepoLock(dir, () => gitq(["fetch", "--prune", "--quiet"], { cwd: dir, timeoutMs: 120000 }));
  const base = await baseRef(dir, p.default_branch);
  const r = await gitq(["merge", "--no-edit", "-m", `Merge ${base} into the job's branch`, base], { cwd: worktree, timeoutMs: 120000 });
  if (r.code === 0) return { clean: true, conflicted: [], base };
  const conflicted = (await gitq(["diff", "--name-only", "--diff-filter=U"], { cwd: worktree, timeoutMs: 60000 })).stdout.split("\n").filter(Boolean);
  if (!conflicted.length) { await gitq(["merge", "--abort"], { cwd: worktree, timeoutMs: 60000 }); throw new Error(`could not merge ${base} into the branch: ${(r.stderr || r.stdout).trim().slice(-600)}`); }
  return { clean: false, conflicted, base };
}

