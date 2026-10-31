// Where work comes from. A source is a row in `sources` with a kind, a project to route to,
// non-secret config, sealed secrets, and a cursor. Each kind is an adapter: it polls (or
// listens), turns what it finds into work items, carries status back, and answers "test".
// The scheduler here runs the polling kinds on their interval or cron and keeps long-lived
// ones (Slack's socket) connected.
import { q, one } from "../../db.ts";
import { open, seal } from "../crypto.ts";
import { emit } from "../events.ts";
import { OPEN, createItem, getItem, type Item, type ItemDraft, type Feedback } from "../items.ts";
import { onComment, reviewDecision } from "../pipeline.ts";
import { registerPoster, type PostMessage } from "../conversations.ts";
import { parseCron, dueSince } from "../cron.ts";

export type SourceRow = {
  id: number; project_id: number | null; kind: string; name: string; config: Record<string, unknown>; secrets: string | null; enabled: boolean;
  interval_sec: number | null; cron: string | null; cursor: Record<string, unknown>; state: Record<string, unknown>;
  last_polled_at: string | null; last_ok_at: string | null; last_error: string | null; created_by: number | null; created_at: string; updated_at: string;
};

export type Field = { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string; kind?: "text" | "textarea" | "number" | "select" | "boolean"; options?: string[]; default?: unknown };

export type SourceContext = {
  source: SourceRow;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  saveCursor: (cursor: Record<string, unknown>) => Promise<void>;
  saveState: (state: Record<string, unknown>) => Promise<void>;
  /** Creates the item (deduplicated by external id), routed to the source's project unless the draft says otherwise. */
  createItem: (draft: ItemDraft) => Promise<{ item: Item; created: boolean }>;
  /** A comment, answer or review verdict that arrived at the source for one of its items. */
  feedback: (itemId: number, f: { author?: string | null; body: string; externalId?: string | null; kind?: Feedback["kind"] }) => Promise<void>;
  /** The item an external reference (ticket key, thread) belongs to, if any. */
  itemByExternalId: (externalId: string) => Promise<Item | null>;
  /** The newest item for a ticket: `externalId` itself or a later request on it (`externalId#2`, …), an open one first. */
  latestItem: (externalId: string) => Promise<Item | null>;
  /** The source's newest open item, if any: for the kinds that keep one at a time. */
  openItem: () => Promise<Item | null>;
  /** What the Sources page shows as this source's problem (a long-lived kind that lost its connection); null clears it. */
  setError: (message: string | null) => Promise<void>;
};

export interface SourceAdapter {
  kind: string;
  label: string;
  description: string;
  /** Optional setup notes the UI shows with the form: where to get the tokens, scopes, a manifest to paste. */
  help?: string;
  fields: Field[];
  /** Polling kinds: default interval in seconds (null = cron only / no polling). */
  defaultIntervalSec: number | null;
  poll?(ctx: SourceContext): Promise<void>;
  /** Long-lived kinds (a socket): start, return how to stop. */
  start?(ctx: SourceContext): Promise<() => Promise<void>>;
  /** Post a status update to where an item of this kind came from. */
  post?(ctx: SourceContext, item: Item, msg: PostMessage): Promise<{ ref?: unknown } | void>;
  test?(ctx: SourceContext): Promise<{ ok: boolean; detail: string }>;
  /** Post a factory-wide message (the daily digest) where this source has a place for it; returns whether it did. */
  broadcast?(ctx: SourceContext, text: string): Promise<boolean>;
  /** Inbound HTTP for this source (webhooks); `token` is the source's hook token. */
  webhook?(ctx: SourceContext, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: unknown }>;
}

const adapters = new Map<string, SourceAdapter>();
export function registerSource(a: SourceAdapter): void {
  adapters.set(a.kind, a);
  if (a.post) registerPoster(a.kind, async (item, msg) => {
    const src = item.source_id ? await getSource(item.source_id) : null;
    if (!src) return;
    return a.post!(contextFor(src), item, msg);
  });
}
export const getAdapter = (kind: string) => adapters.get(kind);
export const listAdapters = () => [...adapters.values()].map((a) => ({ kind: a.kind, label: a.label, description: a.description, help: a.help ?? null, fields: a.fields, defaultIntervalSec: a.defaultIntervalSec, longLived: Boolean(a.start), polls: Boolean(a.poll), webhook: Boolean(a.webhook) }));

export const listSources = () => q<SourceRow>("select * from sources order by kind, name");
export const getSource = (id: number) => one<SourceRow>("select * from sources where id = $1", [id]);
export const sourceByToken = (token: string) => one<SourceRow>("select * from sources where config->>'hookToken' = $1 and enabled", [token]);

export function contextFor(src: SourceRow): SourceContext {
  let secrets: Record<string, string> = {};
  try { secrets = open(src.secrets); } catch { /* without FACTORY_SECRET there are no secrets */ }
  return {
    source: src,
    config: src.config ?? {},
    secrets,
    log: (message, level = "info") => emit({ type: "system", level, message: `[${src.kind}:${src.name}] ${message}`, data: { sourceId: src.id } }).catch(() => {}),
    saveCursor: (cursor) => q("update sources set cursor = $2 where id = $1", [src.id, JSON.stringify(cursor)]).then(() => { src.cursor = cursor; }),
    saveState: (state) => q("update sources set state = $2 where id = $1", [src.id, JSON.stringify(state)]).then(() => { src.state = state; }),
    createItem: (draft) => createItem({ projectId: src.project_id, ...draft, sourceId: src.id }, `${src.kind}:${src.name}`),
    feedback: async (itemId, f) => {
      const it = await getItem(itemId);
      if (!it) return;
      if ((f.kind === "approved" || f.kind === "changes_requested") && it.status === "review") await reviewDecision(itemId, f.kind, f.body, { via: src.kind, name: f.author ?? src.kind, externalId: f.externalId ?? undefined });
      else await onComment(itemId, { source: src.kind, author: f.author, body: f.body, externalId: f.externalId, kind: f.kind });
    },
    itemByExternalId: (externalId) => one<Item>("select * from work_items where source_id = $1 and external_id = $2", [src.id, externalId]),
    latestItem: (externalId) => one<Item>(
      "select * from work_items where source_id = $1 and (external_id = $2 or starts_with(external_id, $2 || '#')) order by (status = any($3)) desc, id desc limit 1",
      [src.id, externalId, OPEN]),
    openItem: () => one<Item>("select * from work_items where source_id = $1 and status = any($2) order by id desc limit 1", [src.id, OPEN]),
    setError: async (message) => {
      const error = message == null ? null : message.slice(0, 2000);
      await q("update sources set last_error = $2 where id = $1", [src.id, error]);
      src.last_error = error;
      // Only the connection this context started speaks for it; a stopped one may still be winding down.
      const h = live.get(src.id);
      if (h && h.updatedAt === src.updated_at) h.error = error;
    },
  };
}

// --- the scheduler -------------------------------------------------------------------

const running = new Map<number, Promise<void>>();
/** Long-lived connections by source. `retryAt`: start() failed, try again then (backing off); `error`: the adapter said it is not working. */
type LiveEntry = { stop: () => Promise<void>; updatedAt: string; retryAt?: number; backoffMs?: number; error?: string | null };
const live = new Map<number, LiveEntry>();
const RETRY_FIRST_MS = 60_000, RETRY_MAX_MS = 15 * 60_000;

export async function pollSource(src: SourceRow, force = false): Promise<void> {
  const a = adapters.get(src.kind);
  if (!a?.poll || running.has(src.id)) return;
  if (!force) {
    // A kind with no interval of its own (a schedule) runs only on the timing it was given: without one it waits.
    if (a.defaultIntervalSec == null && !src.cron?.trim() && !src.interval_sec) return;
    const last = src.last_polled_at ? new Date(src.last_polled_at) : null;
    const due = src.cron
      ? (() => { try { return dueSince(parseCron(src.cron!), last); } catch { return false; } })()
      : !last || Date.now() - last.getTime() >= (src.interval_sec ?? a.defaultIntervalSec ?? 300) * 1000;
    if (!due) return;
  }
  const p = (async () => {
    await q("update sources set last_polled_at = now() where id = $1", [src.id]);
    try {
      await a.poll!(contextFor(src));
      await q("update sources set last_ok_at = now(), last_error = null where id = $1", [src.id]);
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
      await q("update sources set last_error = $2 where id = $1", [src.id, error]);
      await emit({ type: "system", level: "warn", message: `[${src.kind}:${src.name}] poll failed: ${error}`, data: { sourceId: src.id } });
    }
  })();
  running.set(src.id, p);
  try { await p; } finally { running.delete(src.id); }
}

async function reconcileLive(sources: SourceRow[]): Promise<void> {
  for (const src of sources) {
    const a = adapters.get(src.kind);
    const want = Boolean(a?.start && src.enabled);
    const have = live.get(src.id);
    const changed = Boolean(have && have.updatedAt !== src.updated_at);
    if (have && (!want || changed)) { live.delete(src.id); await have.stop().catch(() => {}); }
    // A start that failed is tried again later (a Slack outage at boot must not leave the source dead until someone edits it).
    const retry = Boolean(have && !changed && have.retryAt != null && Date.now() >= have.retryAt);
    if (want && (!have || changed || retry)) {
      // In the map before start() returns, so a problem the adapter reports while starting (setError) lands on this entry.
      const entry: LiveEntry = { stop: async () => {}, updatedAt: src.updated_at };
      live.set(src.id, entry);
      try {
        const stop = await a!.start!(contextFor(src));
        if (live.get(src.id) !== entry) { await stop().catch(() => {}); continue; } // deleted or stopped while starting
        entry.stop = stop;
        if (!entry.error) await q("update sources set last_ok_at = now(), last_error = null where id = $1", [src.id]);
      } catch (e) {
        const error = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
        const backoffMs = retry ? Math.min(RETRY_MAX_MS, (have!.backoffMs ?? RETRY_FIRST_MS) * 2) : RETRY_FIRST_MS;
        Object.assign(entry, { retryAt: Date.now() + backoffMs, backoffMs, error });
        await q("update sources set last_error = $2 where id = $1", [src.id, error]);
        await emit({ type: "system", level: "warn", message: `[${src.kind}:${src.name}] could not start, trying again in ${Math.round(backoffMs / 60_000)} min: ${error}`, data: { sourceId: src.id } });
      }
    }
  }
  for (const [id, h] of live) if (!sources.some((s) => s.id === id)) { live.delete(id); await h.stop().catch(() => {}); }
}

let scanning = false;
export async function scanSources(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const sources = await listSources();
    await reconcileLive(sources);
    await Promise.all(sources.filter((s) => s.enabled).map((s) => pollSource(s)));
  } finally {
    scanning = false;
  }
}

/** Sends a factory-wide message through every enabled source that has somewhere to put it. */
export async function broadcast(text: string): Promise<number> {
  let n = 0;
  for (const src of await listSources()) {
    const a = adapters.get(src.kind);
    if (!a?.broadcast || !src.enabled) continue;
    try { if (await a.broadcast(contextFor(src), text)) n++; } catch (e) { await emit({ type: "system", level: "warn", message: `[${src.kind}:${src.name}] broadcast failed: ${e instanceof Error ? e.message : String(e)}` }); }
  }
  return n;
}

export function startSources(): void {
  setTimeout(() => scanSources().catch((e) => console.error("sources", e)), 4000).unref();
  setInterval(() => scanSources().catch((e) => console.error("sources", e)), 15 * 1000).unref();
}
export async function stopSources(): Promise<void> { for (const [id, h] of live) { live.delete(id); await h.stop().catch(() => {}); } }
/** "connected", "error" (a start that failed and waits to retry, or a connection its adapter reported broken), or null (not long-lived, or off). */
export function liveStatus(id: number): "connected" | "error" | null {
  const h = live.get(id);
  if (!h) return null;
  return h.retryAt != null || h.error ? "error" : "connected";
}

// --- CRUD helpers used by the routes ---------------------------------------------------

/** A polling kind without an interval of its own (a schedule) must be given a cron or an interval, or it would never run. Switched off, it may wait without one. */
function checkTiming(a: SourceAdapter, cron: string | null | undefined, intervalSec: number | null | undefined, enabled: boolean): void {
  if (a.poll && a.defaultIntervalSec == null && enabled && !cron?.trim() && !intervalSec) throw new Error(`a ${a.label.toLowerCase()} needs a cron expression or an interval`);
}

export async function createSource(d: { kind: string; name: string; projectId: number | null; config: Record<string, unknown>; secrets: Record<string, string>; intervalSec?: number | null; cron?: string | null; enabled?: boolean; createdBy?: number | null }): Promise<SourceRow> {
  const a = adapters.get(d.kind);
  if (!a) throw new Error(`unknown source kind ${d.kind}`);
  if (d.cron) parseCron(d.cron);
  checkTiming(a, d.cron, d.intervalSec, d.enabled ?? true);
  const sealed = Object.keys(d.secrets).length ? seal(d.secrets) : null;
  return (await one<SourceRow>("insert into sources (kind, name, project_id, config, secrets, interval_sec, cron, enabled, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *", [d.kind, d.name, d.projectId, JSON.stringify(d.config), sealed, d.intervalSec ?? null, d.cron ?? null, d.enabled ?? true, d.createdBy ?? null]))!;
}

export async function updateSource(id: number, d: { name?: string; projectId?: number | null; config?: Record<string, unknown>; secrets?: Record<string, string>; intervalSec?: number | null; cron?: string | null; enabled?: boolean }): Promise<SourceRow> {
  const src = await getSource(id);
  if (!src) throw new Error("no such source");
  if (d.cron) parseCron(d.cron);
  const a = adapters.get(src.kind);
  if (a) checkTiming(a, "cron" in d ? d.cron : src.cron, "intervalSec" in d ? d.intervalSec : src.interval_sec, d.enabled ?? src.enabled);
  // A webhook's token is its identity: an edit that leaves it out must not mint a new URL.
  const config = d.config ? { ...d.config, ...(src.config?.hookToken && !d.config.hookToken ? { hookToken: src.config.hookToken } : {}) } : undefined;
  let sealed = src.secrets;
  if (d.secrets) {
    let current: Record<string, string> = {};
    try { current = open(src.secrets); } catch { /* unreadable: start over */ }
    for (const [k, v] of Object.entries(d.secrets)) { if (v === "") delete current[k]; else if (v != null) current[k] = v; }
    sealed = Object.keys(current).length ? seal(current) : null;
  }
  return (await one<SourceRow>(
    `update sources set name = coalesce($2, name), project_id = case when $3 then $4 else project_id end, config = coalesce($5, config), secrets = $6, interval_sec = case when $7 then $8 else interval_sec end, cron = case when $9 then $10 else cron end, enabled = coalesce($11, enabled), updated_at = now() where id = $1 returning *`,
    [id, d.name ?? null, "projectId" in d, d.projectId ?? null, config ? JSON.stringify(config) : null, sealed, "intervalSec" in d, d.intervalSec ?? null, "cron" in d, d.cron ?? null, d.enabled ?? null],
  ))!;
}

export async function deleteSource(id: number): Promise<void> {
  const h = live.get(id);
  if (h) { live.delete(id); await h.stop().catch(() => {}); }
  await q("delete from sources where id = $1", [id]);
}

/** What the UI may see of a source: secrets as their last four characters. */
export function publicSource(src: SourceRow) {
  const a = adapters.get(src.kind);
  let secrets: Record<string, string> = {};
  try { secrets = open(src.secrets); } catch { /* none */ }
  const masked: Record<string, string> = {};
  for (const f of a?.fields ?? []) if (f.secret && secrets[f.key]) masked[f.key] = `••••••${secrets[f.key].slice(-4)}`;
  const { secrets: _s, ...rest } = src;
  return { ...rest, secrets: masked, live: liveStatus(src.id), adapter: a ? { label: a.label, polls: Boolean(a.poll), longLived: Boolean(a.start), webhook: Boolean(a.webhook) } : null };
}
