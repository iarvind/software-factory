// Everything that happens to a work item is an event: a status change, a line the agent said,
// a tool it used, a test result, a post to Slack, an approval. Events are appended to the
// database (the audit trail, and what the item page shows) and fanned out in-process to the
// browsers watching over SSE.
import { EventEmitter } from "node:events";
import { q } from "../db.ts";

export type EventType = "status" | "log" | "text" | "tool" | "tool_result" | "note" | "error" | "approval" | "feedback" | "post" | "run" | "verify" | "git" | "system";
export type Level = "debug" | "info" | "warn" | "error";
export type Ev = { id: number; item_id: number | null; run_id: number | null; type: EventType; level: Level; message: string | null; data: unknown; actor: string | null; at: string };

const bus = new EventEmitter();
bus.setMaxListeners(500);

export async function emit(e: { itemId?: number | null; runId?: number | null; type: EventType; level?: Level; message?: string; data?: unknown; actor?: string }): Promise<Ev> {
  const rows = await q<Ev>(
    "insert into events (item_id, run_id, type, level, message, data, actor) values ($1, $2, $3, $4, $5, $6, $7) returning *",
    [e.itemId ?? null, e.runId ?? null, e.type, e.level ?? "info", e.message ?? null, e.data === undefined ? null : JSON.stringify(e.data), e.actor ?? "factory"],
  );
  const ev = rows[0];
  bus.emit("event", ev);
  return ev;
}

/** Fire-and-forget: a log line from inside a run must never throw into the runner. */
export function log(itemId: number | null, runId: number | null, message: string, level: Level = "info", data?: unknown): void {
  emit({ itemId, runId, type: "log", level, message, data }).catch((err) => console.error("event write failed", err));
}

export function subscribe(fn: (e: Ev) => void): () => void {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}

export const listEvents = (itemId: number, after = 0, limit = 2000) => q<Ev>("select * from events where item_id = $1 and id > $2 order by id limit $3", [itemId, after, limit]);
export const listRunEvents = (runId: number, after = 0, limit = 5000) => q<Ev>("select * from events where run_id = $1 and id > $2 order by id limit $3", [runId, after, limit]);
export const recentEvents = (limit = 100) => q<Ev>("select * from events where type in ('status','approval','feedback','post','error','run','verify','git','system') and level <> 'debug' order by id desc limit $1", [limit]);
