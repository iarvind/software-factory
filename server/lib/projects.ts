// Projects: the repositories the factory may work on, with how to test, build and deploy
// each, which gates a person must open, and how much an agent may spend.
import { q, one } from "../db.ts";
import { HttpError } from "./http.ts";

export type GatePolicy = "manual" | "auto" | "auto_low_risk";
export type Gates = { plan: GatePolicy; merge: GatePolicy; deploy: "manual" | "auto" | "off"; review: "ai" | "off" };
export type Limits = { maxTurns: number; maxBudgetUsd: number; maxMinutes: number; maxFixRounds: number; concurrency: number; verifyMinutes: number; maxInReview: number; observeMinutes: number };
/** One MCP server as the CLI takes it: a command to start, or a URL to reach. */
export type McpServer = { type?: "stdio" | "http" | "sse"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
export type Tools = {
  mode: "readonly" | "edit" | "full"; allow: string[]; deny: string[];
  /** Folders outside the worktree the agent may read, never change. */
  dirs: string[];
  /** MCP servers the agent may use, by name. */
  mcp: Record<string, McpServer>;
};

export type Project = {
  id: number; slug: string; name: string; description: string | null; repo_url: string | null; local_path: string | null; default_branch: string;
  runner: string | null; model: string | null; effort: string | null; setup_command: string | null; test_command: string | null; build_command: string | null; deploy_command: string | null; health_url: string | null;
  delivery: "pr" | "local"; gates: Gates; limits: Limits; tools: Tools; env: Record<string, string>; instructions: string | null; paused: boolean;
  created_by: number | null; created_at: string; updated_at: string;
};

export const DEFAULT_GATES: Gates = { plan: "manual", merge: "manual", deploy: "manual", review: "ai" };
export const DEFAULT_LIMITS: Limits = {
  maxTurns: Number(process.env.DEFAULT_MAX_TURNS || 150), maxBudgetUsd: Number(process.env.DEFAULT_MAX_BUDGET_USD || 8), maxMinutes: 60, maxFixRounds: 3, concurrency: 1, verifyMinutes: 20, maxInReview: 3, observeMinutes: 2,
};
export const DEFAULT_TOOLS: Tools = { mode: "edit", allow: [], deny: [], dirs: [], mcp: {} };

export function withDefaults(p: Project): Project {
  return { ...p, gates: { ...DEFAULT_GATES, ...(p.gates ?? {}) }, limits: { ...DEFAULT_LIMITS, ...(p.limits ?? {}) }, tools: { ...DEFAULT_TOOLS, ...(p.tools ?? {}) }, env: p.env ?? {} };
}

// An MCP server's env and headers can carry keys. Only a ${NAME} reference, maybe after a word ("Bearer ${TOKEN}"; filled in from the project's
// environment when the agent starts) is shown back; anything else reads as HIDDEN, and saving HIDDEN keeps the stored value.
export const HIDDEN = "••••••";
const hide = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /^[A-Za-z -]*\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v) ? v : HIDDEN])) : o);
export function maskMcp(mcp: Record<string, McpServer>): Record<string, McpServer> {
  return Object.fromEntries(Object.entries(mcp).map(([n, s]) => [n, { ...s, ...(s.env ? { env: hide(s.env) } : {}), ...(s.headers ? { headers: hide(s.headers) } : {}) }]));
}
export function unmaskMcp(next: Record<string, McpServer>, prev: Record<string, McpServer>): Record<string, McpServer> {
  const keep = (o: Record<string, string> | undefined, old: Record<string, string> | undefined, where: string) => {
    if (!o) return o;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => {
      if (v !== HIDDEN) return [k, v];
      if (old?.[k] == null) throw new HttpError(400, `${where} ${k} has no saved value; type it again`);
      return [k, old[k]];
    }));
  };
  return Object.fromEntries(Object.entries(next).map(([n, s]) => [n, { ...s, ...(s.env ? { env: keep(s.env, prev[n]?.env, `${n} env`) } : {}), ...(s.headers ? { headers: keep(s.headers, prev[n]?.headers, `${n} header`) } : {}) }]));
}
/** A project as the API shows it: environment names without values, MCP keys hidden. */
export const publicProject = <P extends Project>(p: P) => ({ ...p, env: Object.keys(p.env ?? {}), tools: { ...p.tools, mcp: maskMcp(p.tools.mcp) } });

export async function listProjects(): Promise<Project[]> { return (await q<Project>("select * from projects order by name")).map(withDefaults); }
export async function getProject(id: number | null | undefined): Promise<Project | null> {
  if (!id) return null;
  const p = await one<Project>("select * from projects where id = $1", [id]);
  return p ? withDefaults(p) : null;
}
export async function mustProject(id: number | null | undefined): Promise<Project> {
  const p = await getProject(id);
  if (!p) throw new HttpError(404, "no such project");
  return p;
}
export async function projectBySlug(slug: string): Promise<Project | null> {
  const p = await one<Project>("select * from projects where slug = $1", [slug]);
  return p ? withDefaults(p) : null;
}

/** Does a gate wait for a person, given the item's risk? */
export function gateIsManual(policy: GatePolicy, risk: string | null): boolean {
  if (policy === "auto") return false;
  if (policy === "auto_low_risk") return risk === "high";
  return true;
}

// --- the book: notes left for the next job ---------------------------------

export type Note = { id: number; project_id: number | null; item_id: number | null; author: string; body: string; tags: string[]; created_at: string };
export const notesFor = (projectId: number, limit = 12) => q<Note>("select * from notes where project_id = $1 order by id desc limit $2", [projectId, limit]);
export const listNotes = (projectId?: number) => q<Note>(projectId ? "select * from notes where project_id = $1 order by id desc limit 200" : "select * from notes order by id desc limit 200", projectId ? [projectId] : []);
export async function addNote(n: { projectId: number | null; itemId?: number | null; author: string; body: string; tags?: string[] }): Promise<Note> {
  return (await one<Note>("insert into notes (project_id, item_id, author, body, tags) values ($1, $2, $3, $4, $5) returning *", [n.projectId, n.itemId ?? null, n.author, n.body.trim().slice(0, 4000), n.tags ?? []]))!;
}
export const deleteNote = (id: number) => q("delete from notes where id = $1", [id]);
