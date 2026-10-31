// Work items: one row per request, wherever it came from. The status is the one word that
// says where the request is in the factory; every change of it is an event, and the
// pipeline (pipeline.ts) is what moves it.
import { q, one } from "../db.ts";
import { emit } from "./events.ts";
import { HttpError } from "./http.ts";
import type { Plan } from "./prompts.ts";

export const STATUSES = ["inbox", "planning", "needs_info", "awaiting_approval", "queued", "building", "verifying", "reviewing", "review", "fixing", "merging", "deploying", "done", "failed", "cancelled", "blocked"] as const;
export type Status = (typeof STATUSES)[number];
export const OPEN: Status[] = ["inbox", "planning", "needs_info", "awaiting_approval", "queued", "building", "verifying", "reviewing", "review", "fixing", "merging", "deploying", "blocked"];
export const ACTIVE: Status[] = ["planning", "building", "verifying", "reviewing", "fixing", "merging", "deploying"];
export const CLOSED: Status[] = ["done", "failed", "cancelled"];
export type Gate = "plan" | "merge" | "deploy";

/** Where a request came from and where its status goes back to. */
export type Origin =
  | { kind: "manual" }
  | { kind: "api" }
  | { kind: "slack"; team?: string; channel: string; ts: string; thread_ts?: string; user?: string }
  | { kind: "jira"; key: string; baseUrl?: string }
  | { kind: "github"; repo: string; issue: number }
  | { kind: "linear"; issueId: string; identifier?: string }
  | { kind: "schedule"; sourceId: number }
  | { kind: "watch"; sourceId: number }
  | { kind: "webhook"; sourceId: number }
  | { kind: string; [k: string]: unknown };

export type Item = {
  id: number; project_id: number | null; source_id: number | null; external_id: string | null; external_url: string | null; origin: Origin;
  title: string; body: string; kind: string | null; size: string | null; risk: string | null; priority: number; status: Status; gate: Gate | null;
  plan: Plan | null; branch: string | null; worktree: string | null; base_sha: string | null; head_sha: string | null; pr_url: string | null; pr_number: number | null; failed_stage: string | null;
  requester_id: number | null; requester_name: string | null; assignee_id: number | null; labels: string[];
  cost_usd: number; turns: number; fix_rounds: number; verify_rounds: number; error: string | null; paused: boolean;
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null; due_at: string | null;
};

export type ItemDraft = {
  title: string; body?: string; projectId?: number | null; sourceId?: number | null; externalId?: string | null; externalUrl?: string | null; origin?: Origin;
  priority?: number; labels?: string[]; requesterId?: number | null; requesterName?: string | null; dueAt?: string | null;
};

export const getItem = (id: number) => one<Item>("select * from work_items where id = $1", [id]);
export async function mustItem(id: number): Promise<Item> {
  const it = await getItem(id);
  if (!it) throw new HttpError(404, `no item #${id}`);
  return it;
}

/** Creates the item unless the same external id from the same source already exists; returns which. */
export async function createItem(d: ItemDraft, actor = "factory"): Promise<{ item: Item; created: boolean }> {
  if (d.sourceId && d.externalId) {
    const existing = await one<Item>("select * from work_items where source_id = $1 and external_id = $2", [d.sourceId, d.externalId]);
    if (existing) return { item: existing, created: false };
  }
  const item = (await one<Item>(
    `insert into work_items (project_id, source_id, external_id, external_url, origin, title, body, priority, labels, requester_id, requester_name, due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
    [d.projectId ?? null, d.sourceId ?? null, d.externalId ?? null, d.externalUrl ?? null, JSON.stringify(d.origin ?? { kind: "manual" }), d.title.trim().slice(0, 300), (d.body ?? "").slice(0, 60000),
      Math.min(5, Math.max(1, d.priority ?? 3)), d.labels ?? [], d.requesterId ?? null, d.requesterName ?? null, d.dueAt ?? null],
  ))!;
  await emit({ itemId: item.id, type: "status", message: `arrived: ${item.title}`, data: { status: "inbox", origin: item.origin }, actor });
  return { item, created: true };
}

/** Thrown when a stage tries to move an item that a person has already closed; stages unwind on it. */
export class ItemClosed extends Error { constructor(id: number, status: string) { super(`#${id} is ${status}`); } }

export async function setStatus(id: number, status: Status, opts: { gate?: Gate | null; message?: string; error?: string | null; actor?: string; data?: Record<string, unknown>; /** Allowed to move a closed item (retry, reopen). */ force?: boolean; failedStage?: string | null } = {}): Promise<Item> {
  const finished = CLOSED.includes(status);
  const item = await one<Item>(
    `update work_items set status = $2, gate = $3, error = coalesce($4, case when $2 in ('queued','building','done') then null else error end), updated_at = now(),
       started_at = case when started_at is null and $2 <> 'inbox' then now() else started_at end,
       finished_at = case when $5 then now() else null end,
       failed_stage = case when $7 then $8 else failed_stage end
     where id = $1 and ($6 or status not in ('cancelled', 'done', 'failed')) returning *`,
    [id, status, opts.gate ?? null, opts.error ?? null, finished, opts.force ?? false, opts.failedStage !== undefined, opts.failedStage ?? null],
  );
  if (!item) {
    const now = await one<{ status: string }>("select status from work_items where id = $1", [id]);
    throw now ? new ItemClosed(id, now.status) : new HttpError(404, `no item #${id}`);
  }
  await emit({ itemId: id, type: "status", level: status === "failed" || status === "blocked" ? "error" : "info", message: opts.message ?? status, data: { status, gate: opts.gate ?? null, ...(opts.data ?? {}) }, actor: opts.actor });
  // A closed item waits for nothing: a gate left pending could still be approved later and reopen it.
  if (finished) for (const a of await q<{ id: number; kind: string }>("update approvals set status = 'expired', decided_at = now() where item_id = $1 and status = 'pending' returning id, kind", [id])) {
    await emit({ itemId: id, type: "approval", message: `approval expired: ${a.kind} (the item is ${status})`, data: { approvalId: a.id, kind: a.kind, status: "expired" } });
  }
  return item;
}

/** Moves an item only if it is in one of the expected states; the caller that gets null lost the race and stops. */
export async function claim(id: number, from: Status[], to: Status, message: string): Promise<Item | null> {
  const item = await one<Item>("update work_items set status = $3, gate = null, updated_at = now() where id = $1 and status = any($2) returning *", [id, from, to]);
  if (item) await emit({ itemId: id, type: "status", message, data: { status: to, gate: null } });
  return item;
}

export async function updateItem(id: number, patch: Partial<Pick<Item, "title" | "body" | "project_id" | "priority" | "labels" | "assignee_id" | "paused" | "due_at">>, actor = "factory"): Promise<Item> {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (!keys.length) throw new HttpError(400, "nothing to update");
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const item = await one<Item>(`update work_items set ${sets}, updated_at = now() where id = $1 returning *`, [id, ...keys.map((k) => patch[k])]);
  if (!item) throw new HttpError(404, `no item #${id}`);
  await emit({ itemId: id, type: "system", message: `updated ${keys.join(", ")}`, data: patch, actor });
  return item;
}

export async function savePlan(id: number, plan: Plan): Promise<void> {
  await q("update work_items set plan = $2, kind = $3, size = $4, risk = $5, updated_at = now() where id = $1", [id, JSON.stringify(plan), plan.kind, plan.size, plan.risk]);
}

export async function saveBranch(id: number, v: { branch?: string; worktree?: string | null; baseSha?: string; headSha?: string; prUrl?: string; prNumber?: number | null }): Promise<void> {
  await q(
    `update work_items set branch = coalesce($2, branch), worktree = case when $8 then $3 else worktree end, base_sha = coalesce($4, base_sha), head_sha = coalesce($5, head_sha), pr_url = coalesce($6, pr_url), pr_number = coalesce($7, pr_number), updated_at = now() where id = $1`,
    [id, v.branch ?? null, v.worktree ?? null, v.baseSha ?? null, v.headSha ?? null, v.prUrl ?? null, v.prNumber ?? null, "worktree" in v],
  );
}

export async function addCost(id: number, costUsd: number | undefined, turns: number | undefined): Promise<void> {
  await q("update work_items set cost_usd = cost_usd + $2, turns = turns + $3, updated_at = now() where id = $1", [id, costUsd ?? 0, turns ?? 0]);
}

export const bumpRounds = (id: number, which: "fix_rounds" | "verify_rounds") => q(`update work_items set ${which} = ${which} + 1, updated_at = now() where id = $1`, [id]);

export type ListFilter = { status?: string[]; projectId?: number; q?: string; limit?: number; open?: boolean; requesterId?: number };
export async function listItems(f: ListFilter = {}): Promise<Item[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status?.length) { params.push(f.status); where.push(`status = any($${params.length})`); }
  if (f.open) { params.push(OPEN); where.push(`status = any($${params.length})`); }
  if (f.projectId) { params.push(f.projectId); where.push(`project_id = $${params.length}`); }
  if (f.requesterId) { params.push(f.requesterId); where.push(`requester_id = $${params.length}`); }
  if (f.q) { params.push(`%${f.q}%`); where.push(`(title ilike $${params.length} or body ilike $${params.length})`); }
  params.push(Math.min(500, f.limit ?? 200));
  return q<Item>(`select * from work_items ${where.length ? `where ${where.join(" and ")}` : ""} order by updated_at desc limit $${params.length}`, params);
}

// --- approvals ---------------------------------------------------------------

export type Approval = { id: number; item_id: number; kind: Gate | "info"; status: "pending" | "approved" | "rejected" | "expired"; summary: string | null; payload: unknown; requested_at: string; decided_at: string | null; decided_by: number | null; decided_via: string | null; note: string | null };

export async function requestApproval(itemId: number, kind: Gate, summary: string, payload?: unknown): Promise<Approval> {
  await q("update approvals set status = 'expired', decided_at = now() where item_id = $1 and status = 'pending'", [itemId]);
  const a = (await one<Approval>("insert into approvals (item_id, kind, summary, payload) values ($1, $2, $3, $4) returning *", [itemId, kind, summary.slice(0, 4000), payload === undefined ? null : JSON.stringify(payload)]))!;
  await emit({ itemId, type: "approval", message: `approval requested: ${kind}`, data: { approvalId: a.id, kind, status: "pending" } });
  return a;
}

export const pendingApproval = (itemId: number) => one<Approval>("select * from approvals where item_id = $1 and status = 'pending' order by id desc limit 1", [itemId]);
export const listPendingApprovals = () => q<Approval & { title: string; project_id: number | null }>("select a.*, w.title, w.project_id from approvals a join work_items w on w.id = a.item_id where a.status = 'pending' order by a.requested_at");
export const approvalsFor = (itemId: number) => q<Approval>("select * from approvals where item_id = $1 order by id", [itemId]);

export async function decideApproval(id: number, decision: "approved" | "rejected", by: { userId?: number | null; via: string; name?: string }, note?: string): Promise<Approval> {
  const a = await one<Approval>("update approvals set status = $2, decided_at = now(), decided_by = $3, decided_via = $4, note = $5 where id = $1 and status = 'pending' returning *", [id, decision, by.userId ?? null, by.via, note ?? null]);
  if (!a) throw new HttpError(409, "this approval was already decided or has expired");
  await emit({ itemId: a.item_id, type: "approval", message: `${a.kind} ${decision}${note ? `: ${note}` : ""}`, data: { approvalId: a.id, kind: a.kind, status: decision, via: by.via }, actor: by.name ?? by.via });
  return a;
}

// --- feedback ----------------------------------------------------------------

export type Feedback = { id: number; item_id: number; run_id: number | null; source: string; author: string | null; body: string; kind: "comment" | "changes_requested" | "approved" | "answer"; external_id: string | null; handled_at: string | null; created_at: string };

export async function addFeedback(itemId: number, f: { source: string; author?: string | null; body: string; kind?: Feedback["kind"]; externalId?: string | null; runId?: number | null }): Promise<Feedback | null> {
  const rows = await q<Feedback>(
    `insert into feedback (item_id, run_id, source, author, body, kind, external_id) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (item_id, source, external_id) where external_id is not null do nothing returning *`,
    [itemId, f.runId ?? null, f.source, f.author ?? null, f.body.slice(0, 20000), f.kind ?? "comment", f.externalId ?? null],
  );
  const fb = rows[0];
  if (!fb) return null;
  await emit({ itemId, type: "feedback", message: fb.body.length > 300 ? `${fb.body.slice(0, 300)}…` : fb.body, data: { feedbackId: fb.id, kind: fb.kind, source: fb.source }, actor: fb.author ?? fb.source });
  return fb;
}

export const feedbackFor = (itemId: number) => q<Feedback>("select * from feedback where item_id = $1 order by id", [itemId]);
export const unhandledFeedback = (itemId: number) => q<Feedback>("select * from feedback where item_id = $1 and handled_at is null order by id", [itemId]);
export const markHandled = (ids: number[]) => (ids.length ? q("update feedback set handled_at = now() where id = any($1)", [ids]) : Promise.resolve([]));

// --- runs --------------------------------------------------------------------

export type Run = { id: number; item_id: number; kind: string; runner: string; model: string | null; effort: string | null; session_id: string | null; status: string; worktree: string | null; branch: string | null; prompt: string | null; result: string | null; structured: unknown; cost_usd: number | null; turns: number | null; usage: unknown; exit_code: number | null; error: string | null; created_at: string; started_at: string | null; finished_at: string | null };

export const runsFor = (itemId: number) => q<Run>("select id, item_id, kind, runner, model, effort, session_id, status, worktree, branch, left(result, 20000) as result, structured, cost_usd, turns, usage, exit_code, error, created_at, started_at, finished_at from runs where item_id = $1 order by id", [itemId]);
export const getRun = (id: number) => one<Run>("select * from runs where id = $1", [id]);
export const lastRun = (itemId: number, kinds: string[]) => one<Run>("select * from runs where item_id = $1 and kind = any($2) and session_id is not null order by id desc limit 1", [itemId, kinds]);
