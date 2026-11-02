// The apps already on this Mac, offered as projects: the git checkouts one level under rack's
// roots (~/Self/dashboard/services.json), with commands guessed from what each repository has.
// A guess is only a starting point; the person adding the project sees and edits every field.
import fs from "node:fs/promises";
import path from "node:path";
import { run } from "./exec.ts";
import { HttpError } from "./http.ts";
import { listProjects } from "./projects.ts";

export type Suggestions = { test_command: string | null; build_command: string | null; deploy_command: string | null; setup_command: string | null; health_url: string | null; instructions: string | null };
export type Candidate = { path: string; name: string; slug: string; default_branch: string; remote: string | null; github: string | null; suggestions: Suggestions };

const HOME = process.env.HOME || "";
const SERVICES = path.join(HOME, "Self/dashboard/services.json");
const MAX = 60;

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, HOME || "~");

async function readText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch { return null; }
}
async function readJson<T>(file: string): Promise<T | null> {
  const t = await readText(file);
  if (t == null) return null;
  try { return JSON.parse(t) as T; } catch { return null; }
}
const exists = (file: string) => fs.access(file).then(() => true, () => false);
const real = (p: string) => fs.realpath(p).catch(() => path.resolve(p));

export async function roots(): Promise<string[]> {
  const s = await readJson<{ roots?: unknown }>(SERVICES);
  const list = Array.isArray(s?.roots) ? s.roots.filter((r): r is string => typeof r === "string" && r.trim() !== "") : [];
  return (list.length ? list : ["~/Self"]).map((r) => path.resolve(expandHome(r.trim())));
}

/** Resolved local paths of the projects already registered, so they are not offered twice. */
export async function registeredPaths(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of await listProjects()) if (p.local_path) out.add(await real(expandHome(p.local_path)));
  return out;
}

/** A checkout's own .git directory; a .git file is a worktree or submodule of another repository. */
async function isCheckout(dir: string): Promise<boolean> {
  try { return (await fs.lstat(path.join(dir, ".git"))).isDirectory(); } catch { return false; }
}

export const slugFor = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 63);

/** The first prose paragraph of a README: past the title, badges, HTML and code. */
export function firstParagraph(md: string, max = 600): string | null {
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const para: string[] = [];
  let fenced = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fenced = !fenced; if (para.length) break; continue; }
    if (fenced) continue;
    const skip = line === "" || /^#/.test(line) || /^(!\[|\[!\[|<|\|)/.test(line) || /^([-*_=])\1{2,}$/.test(line);
    if (skip) { if (para.length) break; continue; }
    para.push(line);
  }
  const text = para.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > max / 2 ? cut.lastIndexOf(" ") : cut.length)}…`;
}

function makeTargets(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^([^\s:=#.][^:=#]*?)\s*::?(?!=)/.exec(line);
    if (m) for (const t of m[1].split(/\s+/)) out.add(t);
  }
  return out;
}

/** First source that has an answer wins, in this order: package.json, Makefile, go.mod, Python, dashboard.json. */
export async function suggest(dir: string): Promise<Suggestions> {
  const s: Suggestions = { test_command: null, build_command: null, deploy_command: null, setup_command: null, health_url: null, instructions: null };
  const fill = (k: keyof Suggestions, v: string | null | undefined) => { if (v && !s[k]) s[k] = v; };

  const pkg = await readJson<{ scripts?: Record<string, string>; dependencies?: object; devDependencies?: object }>(path.join(dir, "package.json"));
  if (pkg) {
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    // npm init's placeholder test script fails on purpose; it is not a test suite.
    if (typeof scripts.test === "string" && !/no test specified/.test(scripts.test)) fill("test_command", "npm test");
    if (scripts.typecheck) fill("build_command", "npm run typecheck");
    else if (scripts.build) fill("build_command", "npm run build");
    // A worktree starts without the checkout's untracked files: bring its .env along and share its
    // node_modules (a symlink is seconds; npm ci is minutes) so the tests can run at all.
    // A worktree starts without the checkout's untracked files. The .env is copied so the tests can reach their database
    // (the agent could read the checkout's copy anyway); dependencies are installed fresh, never shared with the live checkout.
    const steps: string[] = [];
    const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    if (await exists(path.join(dir, ".env"))) steps.push(`cp ${q(path.join(dir, ".env"))} .env`);
    if (pkg.dependencies || pkg.devDependencies || scripts.install) steps.push((await exists(path.join(dir, "package-lock.json"))) ? "npm ci" : "npm install");
    if (steps.length) fill("setup_command", steps.join(" && "));
  }

  for (const f of ["Makefile", "makefile", "GNUmakefile"]) {
    const text = await readText(path.join(dir, f));
    if (text == null) continue;
    const t = makeTargets(text);
    if (t.has("deploy")) fill("deploy_command", "make deploy");
    if (t.has("test")) fill("test_command", "make test");
    if (t.has("check")) fill("build_command", "make check");
    break;
  }

  if (await exists(path.join(dir, "go.mod"))) { fill("test_command", "go test ./..."); fill("build_command", "go build ./..."); }
  if ((await exists(path.join(dir, "pyproject.toml"))) || (await exists(path.join(dir, "requirements.txt")))) fill("test_command", "pytest");

  const dash = await readJson<{ deploy?: unknown; services?: Array<{ port?: unknown; health?: unknown }> }>(path.join(dir, "dashboard.json"));
  if (dash) {
    if (typeof dash.deploy === "string") fill("deploy_command", dash.deploy);
    const svc = Array.isArray(dash.services) ? dash.services.find((x) => x && typeof x.port === "number" && typeof x.health === "string") : undefined;
    if (svc) {
      const h = String(svc.health);
      fill("health_url", /^https?:\/\//.test(h) ? h : `http://127.0.0.1:${svc.port}${h.startsWith("/") ? h : `/${h}`}`);
    }
  }

  for (const f of ["README.md", "CLAUDE.md"]) {
    const text = await readText(path.join(dir, f));
    if (text != null) fill("instructions", firstParagraph(text));
  }
  return s;
}

/** One checkout as a candidate project, or null when it is not one (missing, a worktree, no .git). */
export async function inspectRepo(input: string): Promise<Candidate | null> {
  try {
    const dir = await real(path.resolve(expandHome(input)));
    if (!(await fs.stat(dir)).isDirectory() || !(await isCheckout(dir))) return null;
    const [head, origin, suggestions] = await Promise.all([
      run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dir, timeoutMs: 5000 }).then((r) => (r.code === 0 && r.stdout.trim() ? { ...r, stdout: r.stdout.trim().replace(/^origin\//, "") } : run("git", ["symbolic-ref", "--short", "HEAD"], { cwd: dir, timeoutMs: 5000 }))),
      run("git", ["remote", "get-url", "origin"], { cwd: dir, timeoutMs: 5000 }),
      suggest(dir),
    ]);
    const remote = origin.code === 0 ? origin.stdout.trim() || null : null;
    const gh = remote ? /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote) : null;
    const name = path.basename(dir);
    return {
      path: dir, name, slug: slugFor(name),
      default_branch: (head.code === 0 && head.stdout.trim()) || "main",
      remote, github: gh ? `${gh[1]}/${gh[2]}` : null, suggestions,
    };
  } catch { return null; }
}

/** Unregistered git checkouts one level under each root, by name. With a folder, that folder alone stands in for
 *  the roots, and it is offered itself when it is a checkout: a repository anywhere on this Mac can be added. */
export async function discover(folder?: string): Promise<{ roots: string[]; candidates: Candidate[] }> {
  let rs: string[];
  const dirs: string[] = [];
  const seen = new Set<string>();
  const taken = await registeredPaths();
  const offer = async (dir: string) => {
    if (seen.has(dir) || taken.has(dir) || !(await isCheckout(dir))) return;
    seen.add(dir);
    dirs.push(dir);
  };
  if (folder) {
    const dir = await real(path.resolve(expandHome(folder.trim())));
    if (!(await fs.stat(dir).then((st) => st.isDirectory(), () => false))) throw new HttpError(400, `${folder} is not a folder on this machine`);
    rs = [dir];
    await offer(dir);
  } else rs = await roots();
  for (const root of rs) {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") || !(e.isDirectory() || e.isSymbolicLink())) continue;
      try { await offer(await real(path.join(root, e.name))); } catch { /* unreadable: skip */ }
    }
  }
  dirs.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: "base" }));
  const picked = dirs.slice(0, MAX);
  // A few at a time: each one is two git processes and a handful of file reads.
  const out: Array<Candidate | null> = new Array(picked.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, picked.length) }, async () => {
    while (next < picked.length) { const i = next++; out[i] = await inspectRepo(picked[i]); }
  }));
  return { roots: rs, candidates: out.filter((c): c is Candidate => c !== null) };
}

/** The folders inside one folder, for typing a path: the part before the last slash is listed, the rest is left to filter. */
export async function folders(input: string): Promise<{ dir: string; folders: Array<{ path: string; git: boolean }> }> {
  const typed = expandHome(input.trim() || "~/");
  const dir = path.resolve(typed.endsWith("/") ? typed : path.dirname(typed));
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { /* missing or unreadable: nothing to offer */ }
  const names = entries.filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink())).map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).slice(0, 200);
  const out = await Promise.all(names.map(async (n) => {
    const p = path.join(dir, n);
    return (await fs.stat(p).then((st) => st.isDirectory(), () => false)) ? { path: p, git: await isCheckout(p) } : null;
  }));
  return { dir, folders: out.filter((f): f is { path: string; git: boolean } => f !== null) };
}
