import fs from "node:fs";
import { Hono } from "hono";
import { z } from "zod";
import { q, one } from "../db.ts";
import { atLeast, audit, type Auth } from "../lib/auth.ts";
import { HttpError, body, idParam, parse, setClause, slug } from "../lib/http.ts";
import { DEFAULT_GATES, DEFAULT_LIMITS, DEFAULT_TOOLS, addNote, deleteNote, listNotes, listProjects, mustProject, publicProject, unmaskMcp, withDefaults, type Project, type Tools as ToolPolicy } from "../lib/projects.ts";
import { baseRef, githubRepo, hasRemote, repoDir } from "../lib/git.ts";
import { run } from "../lib/exec.ts";
import { discover, expandHome, folders, inspectRepo, registeredPaths } from "../lib/discover.ts";
import { listRunners } from "../lib/runners/index.ts";
import type { Env } from "./auth.ts";

export const projectRoutes = new Hono<Env>();
const who = (c: { get: (k: "auth") => Auth | null }) => { const a = c.get("auth"); if (!a) throw new HttpError(401, "login required"); return a; };
const member = (a: Auth) => { if (!atLeast(a.user, "member")) throw new HttpError(403, "members only"); return a; };
const admin = (a: Auth) => { if (!atLeast(a.user, "admin")) throw new HttpError(403, "admins only"); return a; };

const Gates = z.object({ plan: z.enum(["manual", "auto", "auto_low_risk"]), merge: z.enum(["manual", "auto", "auto_low_risk"]), deploy: z.enum(["manual", "auto", "off"]), review: z.enum(["ai", "off"]) }).partial();
const Limits = z.object({ maxTurns: z.number().int().min(1).max(2000), maxBudgetUsd: z.number().min(0.1).max(500), maxMinutes: z.number().int().min(1).max(720), maxFixRounds: z.number().int().min(0).max(10), concurrency: z.number().int().min(1).max(10), verifyMinutes: z.number().int().min(1).max(240), maxInReview: z.number().int().min(1).max(50), observeMinutes: z.number().int().min(0).max(120) }).partial();
const McpServer = z.object({
  type: z.enum(["stdio", "http", "sse"]).optional(), command: z.string().min(1).max(500).optional(), args: z.array(z.string().max(2000)).max(50).optional(),
  env: z.record(z.string(), z.string().max(4000)).optional(), url: z.string().url().max(1000).optional(), headers: z.record(z.string(), z.string().max(4000)).optional(),
}).refine((s) => Boolean(s.command) !== Boolean(s.url), "an MCP server needs a command or a url (not both)");
const Tools = z.object({
  mode: z.enum(["readonly", "edit", "full"]), allow: z.array(z.string().max(200)).max(100), deny: z.array(z.string().max(200)).max(100),
  dirs: z.array(z.string().min(1).max(500).refine((d) => /^[/~]/.test(d), "a folder must be a full path (/… or ~/…)")).max(20),
  mcp: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "an MCP server name is letters, digits, - and _"), McpServer),
}).partial();
const ProjectIn = z.object({
  slug, name: z.string().min(1).max(100), description: z.string().max(2000).nullable().optional(),
  repo_url: z.string().max(500).nullable().optional(), local_path: z.string().max(500).nullable().optional(), default_branch: z.string().min(1).max(100).optional(),
  runner: z.string().max(40).nullable().optional(), model: z.string().max(80).nullable().optional(), effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  setup_command: z.string().max(2000).nullable().optional(), test_command: z.string().max(2000).nullable().optional(), build_command: z.string().max(2000).nullable().optional(), deploy_command: z.string().max(2000).nullable().optional(), health_url: z.string().max(500).nullable().optional(),
  delivery: z.enum(["pr", "local"]).optional(), gates: Gates.optional(), limits: Limits.optional(), tools: Tools.optional(), env: z.record(z.string(), z.string()).optional(), instructions: z.string().max(20000).nullable().optional(), paused: z.boolean().optional(),
});

projectRoutes.get("/projects", async (c) => {
  const projects = await listProjects();
  const counts = await q<{ project_id: number; open: number; done: number }>("select project_id, count(*) filter (where status not in ('done','failed','cancelled'))::int as open, count(*) filter (where status = 'done')::int as done from work_items where project_id is not null group by project_id");
  const by = new Map(counts.map((x) => [x.project_id, x]));
  return c.json(projects.map((p) => ({ ...publicProject(p), open: by.get(p.id)?.open ?? 0, done: by.get(p.id)?.done ?? 0 })));
});

projectRoutes.get("/projects/defaults", (c) => c.json({ gates: DEFAULT_GATES, limits: DEFAULT_LIMITS, tools: DEFAULT_TOOLS, runners: listRunners().map((r) => ({ id: r.id, label: r.label, capabilities: r.capabilities })), defaultRunner: process.env.RUNNER || "claude", defaultModel: process.env.CLAUDE_MODEL || "claude-opus-5-5" }));

/** The folders an agent may read must be there; MCP keys sent back hidden keep their saved values. */
function checkTools(t: Partial<ToolPolicy> | undefined, prev: ToolPolicy | null): Partial<ToolPolicy> | undefined {
  if (!t) return t;
  for (const d of t.dirs ?? []) if (!fs.existsSync(expandHome(d))) throw new HttpError(400, `${d} does not exist on this machine`);
  return t.mcp ? { ...t, mcp: unmaskMcp(t.mcp, prev?.mcp ?? {}) } : t;
}

export async function createProject(b: z.infer<typeof ProjectIn>, userId: number): Promise<Project> {
  if (!b.repo_url && !b.local_path) throw new HttpError(400, "a project needs a repository URL or a local path");
  if (b.local_path && !fs.existsSync(expandHome(b.local_path))) throw new HttpError(400, `${b.local_path} does not exist on this machine`);
  b = { ...b, tools: checkTools(b.tools, null) };
  if (b.runner && !listRunners().some((r) => r.id === b.runner)) throw new HttpError(400, `unknown runner ${b.runner}`);
  const exists = await one("select 1 from projects where slug = $1", [b.slug]);
  if (exists) throw new HttpError(409, `a project with slug ${b.slug} exists`);
  const p = await one<Project>(
    `insert into projects (slug, name, description, repo_url, local_path, default_branch, runner, model, effort, setup_command, test_command, build_command, deploy_command, health_url, delivery, gates, limits, tools, env, instructions, paused, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) returning *`,
    [b.slug, b.name, b.description ?? null, b.repo_url || null, b.local_path || null, b.default_branch ?? "main", b.runner ?? null, b.model ?? null, b.effort ?? null, b.setup_command ?? null, b.test_command ?? null, b.build_command ?? null, b.deploy_command ?? null, b.health_url ?? null,
      b.delivery ?? (b.local_path ? "local" : "pr"), JSON.stringify({ ...DEFAULT_GATES, ...(b.gates ?? {}) }), JSON.stringify({ ...DEFAULT_LIMITS, ...(b.limits ?? {}) }), JSON.stringify({ ...DEFAULT_TOOLS, ...(b.tools ?? {}) }), JSON.stringify(b.env ?? {}), b.instructions ?? null, b.paused ?? false, userId],
  );
  await audit(userId, "project.create", b.slug);
  return withDefaults(p!);
}

// What a project runs on this machine (commands, env, tools, where it lives) and which gates it keeps are an admin's call;
// a member may tune the words and the model.
const MEMBER_FIELDS = new Set(["name", "description", "instructions", "model", "effort", "paused"]);

projectRoutes.post("/projects", async (c) => {
  const a = admin(who(c));
  return c.json(publicProject(await createProject(await body(c, ProjectIn), a.user.id)), 201);
});

// Before /projects/:id, which would otherwise take "discover" for an id.
// Looking in a folder of one's choosing lists what is on this Mac, so that, like adding a project, is an admin's.
projectRoutes.get("/projects/discover", async (c) => {
  const dir = c.req.query("dir");
  if (!dir) { member(who(c)); return c.json(await discover()); }
  admin(who(c));
  return c.json(await discover(dir));
});
projectRoutes.get("/projects/discover/folders", async (c) => { admin(who(c)); return c.json(await folders(c.req.query("dir") ?? "")); });

projectRoutes.post("/projects/discover/register", async (c) => {
  const a = admin(who(c));
  const b = await body(c, z.object({
    path: z.string().min(1).max(500), slug: slug.optional(), name: z.string().min(1).max(100).optional(),
    overrides: ProjectIn.omit({ slug: true, name: true, repo_url: true, local_path: true }).partial().optional(),
  }));
  const found = await inspectRepo(b.path);
  if (!found) throw new HttpError(400, `${b.path} is not a git checkout on this machine (a worktree, or a folder without its own .git, cannot be a project)`);
  if ((await registeredPaths()).has(found.path)) throw new HttpError(409, `${found.path} is already a project`);
  const s = found.suggestions;
  const input = parse(ProjectIn, {
    slug: b.slug ?? found.slug, name: b.name ?? found.name, local_path: found.path, default_branch: found.default_branch, delivery: "local",
    setup_command: s.setup_command, test_command: s.test_command, build_command: s.build_command, deploy_command: s.deploy_command, health_url: s.health_url, instructions: s.instructions,
    ...(b.overrides ?? {}),
  });
  return c.json(publicProject(await createProject(input, a.user.id)), 201);
});

projectRoutes.get("/projects/:id", async (c) => c.json(publicProject(await mustProject(idParam(c)))));

projectRoutes.patch("/projects/:id", async (c) => {
  const a = member(who(c));
  const id = idParam(c);
  const p = await mustProject(id);
  const b = await body(c, ProjectIn.partial());
  const restricted = Object.keys(b).filter((k) => !MEMBER_FIELDS.has(k));
  if (restricted.length && !atLeast(a.user, "admin")) throw new HttpError(403, `only an admin can change ${restricted.join(", ")}`);
  if (b.runner && !listRunners().some((r) => r.id === b.runner)) throw new HttpError(400, `unknown runner ${b.runner}`);
  const patch: Record<string, unknown> = { ...b };
  if (b.gates) patch.gates = { ...p.gates, ...b.gates };
  if (b.limits) patch.limits = { ...p.limits, ...b.limits };
  if (b.tools) patch.tools = { ...p.tools, ...checkTools(b.tools, p.tools) };
  if (b.env) { const env = { ...p.env }; for (const [k, v] of Object.entries(b.env)) { if (v === "") delete env[k]; else env[k] = v; } patch.env = env; }
  const { sql, params } = setClause(patch, ["slug", "name", "description", "repo_url", "local_path", "default_branch", "runner", "model", "effort", "setup_command", "test_command", "build_command", "deploy_command", "health_url", "delivery", "gates", "limits", "tools", "env", "instructions", "paused"], 2, ["gates", "limits", "tools", "env"]);
  const out = await one<Project>(`update projects set ${sql}, updated_at = now() where id = $1 returning *`, [id, ...params]);
  await audit(a.user.id, "project.update", p.slug, Object.keys(b));
  return c.json(publicProject(withDefaults(out!)));
});

projectRoutes.delete("/projects/:id", async (c) => {
  const a = admin(who(c));
  const p = await mustProject(idParam(c));
  const open = await one<{ n: number }>("select count(*)::int as n from work_items where project_id = $1 and status not in ('done','failed','cancelled')", [p.id]);
  if (open && open.n > 0) throw new HttpError(409, `${open.n} open item(s) still point at this project; cancel them first`);
  await q("delete from projects where id = $1", [p.id]);
  await audit(a.user.id, "project.delete", p.slug);
  return c.json({ ok: true });
});

/** Is the project reachable: does the path exist, is it a git repo, is the default branch there, does gh know the remote. */
projectRoutes.post("/projects/:id/check", async (c) => {
  who(c);
  const p = await mustProject(idParam(c));
  const out: Record<string, unknown> = { dir: repoDir(p) };
  try {
    const dir = repoDir(p);
    out.exists = fs.existsSync(dir);
    if (p.local_path) {
      out.git = fs.existsSync(`${dir}/.git`);
      if (out.git) {
        out.remote = await hasRemote(dir);
        const r = await run("git", ["rev-parse", "--verify", "--quiet", p.default_branch], { cwd: dir, timeoutMs: 20000 });
        out.defaultBranch = r.code === 0;
        const st = await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir, timeoutMs: 20000 });
        out.clean = st.stdout.trim() === "";
        out.base = await baseRef(dir, p.default_branch);
        out.github = await githubRepo(dir);
      }
    } else {
      out.cloned = fs.existsSync(`${dir}/.git`);
      const ls = await run("git", ["ls-remote", "--heads", p.repo_url!, p.default_branch], { timeoutMs: 60000 });
      out.remoteReachable = ls.code === 0;
      out.defaultBranch = ls.stdout.includes(`refs/heads/${p.default_branch}`);
    }
    const gh = await run("gh", ["auth", "status"], { timeoutMs: 20000 });
    out.gh = gh.code === 0;
    out.ok = Boolean(out.exists !== false && (out.git ?? out.remoteReachable) && out.defaultBranch !== false);
  } catch (e) { out.ok = false; out.error = e instanceof Error ? e.message : String(e); }
  return c.json(out);
});

projectRoutes.get("/projects/:id/notes", async (c) => c.json(await listNotes(idParam(c))));
projectRoutes.get("/notes", async (c) => c.json(await listNotes()));
projectRoutes.post("/projects/:id/notes", async (c) => {
  const a = member(who(c));
  const b = await body(c, z.object({ body: z.string().min(3).max(4000), tags: z.array(z.string().max(30)).max(5).optional() }));
  return c.json(await addNote({ projectId: idParam(c), author: a.user.name || a.user.email, body: b.body, tags: b.tags }), 201);
});
projectRoutes.delete("/notes/:id", async (c) => { member(who(c)); await deleteNote(idParam(c)); return c.json({ ok: true }); });
