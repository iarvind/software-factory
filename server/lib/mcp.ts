// MCP servers a project's agents may use: keeping their keys out of the API's answers, and
// copying the ones Claude Code already has on this machine into a project.
//
// A key stays in the server's own definition rather than the project's environment: the CLI hands
// it to the MCP server process only, while the environment is the agent's shell too (and `env` is
// an allowed command whose output lands in the item's log).
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./http.ts";

/** One MCP server as the CLI takes it: a command to start, or a URL to reach. */
export type McpServer = { type?: "stdio" | "http" | "sse"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
export type McpServers = Record<string, McpServer>;

// ---------- hiding keys ----------

export const HIDDEN = "••••••";
// A ${NAME} reference, maybe after a word ("Bearer ${TOKEN}"), is shown; it holds no key itself.
const REF = /^[A-Za-z -]*\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const SECRETISH = /key|token|secret|passw|pwd|auth|credential|cookie|session|private/i;

/** env and header values: anything but a reference could be a key. */
const maskValue = (v: string) => (REF.test(v) ? v : HIDDEN);
/** A command-line argument: only what looks like a key (after a key-like flag, in a URL, a long opaque string). */
function maskArg(a: string, before?: string): string {
  if (a.includes("${")) return a;
  const flag = /^(--?[\w.-]+)=(.+)$/.exec(a);
  if (flag) return SECRETISH.test(flag[1]) ? `${flag[1]}=${HIDDEN}` : `${flag[1]}=${maskUrl(flag[2])}`;
  if (before && /^--?[\w.-]+$/.test(before) && SECRETISH.test(before)) return HIDDEN;
  if (/:\/\//.test(a)) return maskUrl(a);
  return !a.includes("/") && a.length >= 32 && /\d/.test(a) && /[A-Za-z]/.test(a) ? HIDDEN : a;
}
/** A URL's password and key-like query values. */
function maskUrl(u: string): string {
  if (u.includes("${")) return u;
  return u.replace(/(:\/\/[^/\s:@]+:)[^/\s@]+@/, `$1${HIDDEN}@`).replace(/([?&][^=&#]+=)([^&#]*)/g, (m, k: string) => (SECRETISH.test(k) ? `${k}${HIDDEN}` : m));
}
const maskArgs = (args: string[]) => args.map((a, i) => maskArg(a, args[i - 1]));
const mapValues = (o: Record<string, string> | undefined, f: (v: string) => string) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)])) : o);

/** The servers as the API shows them: keys replaced by HIDDEN. */
export function maskMcp(mcp: McpServers): McpServers {
  return Object.fromEntries(Object.entries(mcp).map(([n, s]) => [n, {
    ...s,
    ...(s.env ? { env: mapValues(s.env, maskValue) } : {}),
    ...(s.headers ? { headers: mapValues(s.headers, maskValue) } : {}),
    ...(s.args ? { args: maskArgs(s.args) } : {}),
    ...(s.url ? { url: maskUrl(s.url) } : {}),
  }]));
}

/** What came back exactly as it was shown for a saved value is that saved value; any other HIDDEN has nothing behind it. */
export function unmaskMcp(next: McpServers, prev: McpServers): McpServers {
  const restore = (v: string, shown: string | undefined, saved: string | undefined, where: string) => {
    if (!v.includes(HIDDEN)) return v;
    if (saved != null && shown === v) return saved;
    throw new HttpError(400, `${where} has no saved value to keep; type it again`);
  };
  return Object.fromEntries(Object.entries(next).map(([n, s]) => {
    const old = prev[n] ?? {};
    const shownArgs = maskArgs(old.args ?? []);
    const args = s.args?.map((a, i) => {
      if (!a.includes(HIDDEN)) return a;
      const at = shownArgs[i] === a ? i : shownArgs.indexOf(a); // the same argument, maybe moved
      return restore(a, shownArgs[at], old.args?.[at], `${n} argument ${a}`);
    });
    return [n, {
      ...s,
      ...(s.env ? { env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, restore(v, old.env?.[k] != null ? maskValue(old.env[k]) : undefined, old.env?.[k], `${n} env ${k}`)])) } : {}),
      ...(s.headers ? { headers: Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, restore(v, old.headers?.[k] != null ? maskValue(old.headers[k]) : undefined, old.headers?.[k], `${n} header ${k}`)])) } : {}),
      ...(args ? { args } : {}),
      ...(s.url ? { url: restore(s.url, old.url ? maskUrl(old.url) : undefined, old.url, `${n} url`) } : {}),
    }];
  }));
}

// ---------- Claude Code's own servers on this machine ----------

export type Found = { key: string; name: string; scope: "user" | "local" | "project"; where: string; server: McpServer };

/** Claude Code's global config: $CLAUDE_CONFIG_DIR/.claude.json when that is set, else ~/.claude.json. */
export const claudeConfigPath = () => path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME || "", ".claude.json");

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { const v = JSON.parse(await fs.readFile(file, "utf8")) as unknown; return v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { return null; }
}

/** Only what the CLI's --mcp-config takes; an entry with neither a command nor a URL is not a server. */
function normalize(v: unknown): McpServer | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const strings = (o: unknown) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([, x]) => typeof x === "string")) as Record<string, string> : undefined);
  const out: McpServer = {};
  if (s.type === "stdio" || s.type === "http" || s.type === "sse") out.type = s.type;
  if (typeof s.command === "string" && s.command) out.command = s.command;
  if (Array.isArray(s.args)) out.args = s.args.filter((a): a is string => typeof a === "string");
  if (typeof s.url === "string" && s.url) out.url = s.url;
  const env = strings(s.env), headers = strings(s.headers);
  if (env && Object.keys(env).length) out.env = env;
  if (headers && Object.keys(headers).length) out.headers = headers;
  return Boolean(out.command) !== Boolean(out.url) ? out : null;
}

/**
 * The MCP servers `claude mcp add` set up for the user the factory runs as (user scope, and local scope
 * for every folder), plus the project-scope .mcp.json in the given folders (the project's checkout).
 * claude.ai connectors are not here: they live with the account, and `claude -p` does not load them.
 */
export async function claudeServers(folders: string[]): Promise<{ config: string; found: Found[] }> {
  const config = claudeConfigPath();
  const found: Found[] = [];
  const add = (scope: Found["scope"], where: string, servers: unknown) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, v] of Object.entries(servers)) {
      const server = normalize(v);
      if (server && /^[A-Za-z0-9_-]{1,40}$/.test(name)) found.push({ key: `${scope}:${where}:${name}`, name, scope, where, server });
    }
  };
  const j = await readJson(config);
  add("user", config, j?.mcpServers);
  const projects = j?.projects && typeof j.projects === "object" ? (j.projects as Record<string, { mcpServers?: unknown }>) : {};
  for (const [dir, p] of Object.entries(projects).sort(([a], [b]) => a.localeCompare(b))) add("local", dir, p?.mcpServers);
  for (const dir of new Set(folders)) {
    const file = path.join(dir, ".mcp.json");
    add("project", file, (await readJson(file))?.mcpServers);
  }
  return { config, found };
}

/** A found server as the browser may see it: the shape and the names of its settings, never their values. */
export const describe = (f: Found) => ({
  key: f.key, name: f.name, scope: f.scope, where: f.where,
  type: f.server.type ?? (f.server.url ? "http" : "stdio"), command: f.server.command ?? null, args: maskArgs(f.server.args ?? []), url: f.server.url ? maskUrl(f.server.url) : null,
  env: Object.keys(f.server.env ?? {}), headers: Object.keys(f.server.headers ?? {}),
});
