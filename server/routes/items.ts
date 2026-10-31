import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { q } from "../db.ts";
import { atLeast, type Auth } from "../lib/auth.ts";
import { HttpError, body, idParam } from "../lib/http.ts";
import { approvalsFor, createItem, feedbackFor, getRun, listItems, listPendingApprovals, mustItem, pendingApproval, runsFor, updateItem, OPEN, STATUSES, type Item } from "../lib/items.ts";
import { listEvents, listRunEvents, recentEvents, subscribe, type Ev } from "../lib/events.ts";
import { getProject, listProjects, mustProject } from "../lib/projects.ts";
import { diff, readWorktreeFile } from "../lib/git.ts";
import { activeRuns, cancel, decide, isActive, nudge, onComment, retry, reviewDecision, throttled, usage } from "../lib/pipeline.ts";
import { postsFor } from "../lib/conversations.ts";
import { settings } from "../lib/settings.ts";
import { emit } from "../lib/events.ts";
import type { Env } from "./auth.ts";

export const itemRoutes = new Hono<Env>();
const who = (c: { get: (k: "auth") => Auth | null }) => { const a = c.get("auth"); if (!a) throw new HttpError(401, "login required"); return a; };
const member = (a: Auth) => { if (!atLeast(a.user, "member")) throw new HttpError(403, "members only"); return a; };
const name = (a: Auth) => a.user.name || a.user.email;
async function approver(a: Auth): Promise<Auth> {
  const s = await settings();
  if (!atLeast(a.user, s.approverRole)) throw new HttpError(403, `${s.approverRole}s only`);
  return a;
}

/** The board: every open item grouped by status, plus what finished recently. */
itemRoutes.get("/board", async (c) => {
  const items = await q<Item>("select * from work_items where status = any($1) or finished_at > now() - interval '3 days' order by priority, updated_at desc limit 500", [OPEN]);
  const projects = await listProjects();
  const s = await settings();
  const runnerId = process.env.RUNNER || "claude";
  return c.json({ items, projects: projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name, paused: p.paused, delivery: p.delivery })), active: activeRuns(), paused: s.paused, held: throttled(runnerId, s.usageThreshold), usage, statuses: STATUSES });
});

itemRoutes.get("/items", async (c) => {
  const st = c.req.query("status");
  const items = await listItems({ status: st ? st.split(",") : undefined, projectId: c.req.query("project") ? Number(c.req.query("project")) : undefined, q: c.req.query("q") || undefined, limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined, open: c.req.query("open") === "1" });
  return c.json(items);
});

const ItemIn = z.object({ title: z.string().min(2).max(300), body: z.string().max(60000).optional(), projectId: z.number().int().positive().nullable().optional(), priority: z.number().int().min(1).max(5).optional(), labels: z.array(z.string().max(40)).max(20).optional(), dueAt: z.string().nullable().optional() });

itemRoutes.post("/items", async (c) => {
  const a = member(who(c));
  const b = await body(c, ItemIn);
  if (b.projectId) await mustProject(b.projectId);
  const r = await createItem({ title: b.title, body: b.body, projectId: b.projectId ?? null, priority: b.priority, labels: b.labels, requesterId: a.user.id, requesterName: name(a), dueAt: b.dueAt ?? null, origin: a.via === "token" ? { kind: "api" } : { kind: "manual" } }, name(a));
  return c.json(r.item, 201);
});

itemRoutes.get("/items/:id", async (c) => {
  const item = await mustItem(idParam(c));
  const [runs, approvals, feedback, posts, project] = await Promise.all([runsFor(item.id), approvalsFor(item.id), feedbackFor(item.id), postsFor(item.id), getProject(item.project_id)]);
  return c.json({ item, runs, approvals, feedback, posts, project: project ? { id: project.id, slug: project.slug, name: project.name, delivery: project.delivery, default_branch: project.default_branch, gates: project.gates } : null, active: isActive(item.id), pending: await pendingApproval(item.id) });
});

itemRoutes.patch("/items/:id", async (c) => {
  const a = member(who(c));
  const id = idParam(c);
  const b = await body(c, ItemIn.partial().extend({ paused: z.boolean().optional(), assigneeId: z.number().int().nullable().optional() }));
  if (b.projectId) await mustProject(b.projectId);
  const it = await mustItem(id);
  const editable = ["inbox", "needs_info", "awaiting_approval", "blocked", "failed", "cancelled"].includes(it.status) && (it.status !== "awaiting_approval" || it.gate === "plan");
  if (!editable && (b.title !== undefined || b.body !== undefined || b.projectId !== undefined)) throw new HttpError(409, `#${id} is ${it.status}: the request can no longer be changed; add a comment instead`);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = b.title;
  if (b.body !== undefined) patch.body = b.body;
  if (b.projectId !== undefined) patch.project_id = b.projectId;
  if (b.priority !== undefined) patch.priority = b.priority;
  if (b.labels !== undefined) patch.labels = b.labels;
  if (b.paused !== undefined) patch.paused = b.paused;
  if (b.assigneeId !== undefined) patch.assignee_id = b.assigneeId;
  if (b.dueAt !== undefined) patch.due_at = b.dueAt;
  return c.json(await updateItem(id, patch, name(a)));
});

itemRoutes.get("/items/:id/events", async (c) => c.json(await listEvents(idParam(c), Number(c.req.query("after") || 0), Number(c.req.query("limit") || 2000))));

itemRoutes.get("/items/:id/diff", async (c) => {
  const item = await mustItem(idParam(c));
  if (!item.worktree || !item.base_sha) return c.json({ stat: "", patch: "", truncated: false, available: false });
  try { return c.json({ ...(await diff(item.worktree, item.base_sha)), available: true }); }
  catch (e) { return c.json({ stat: "", patch: "", truncated: false, available: false, error: e instanceof Error ? e.message : String(e) }); }
});

itemRoutes.get("/items/:id/file", async (c) => {
  const item = await mustItem(idParam(c));
  const p = c.req.query("path") || "";
  if (!item.worktree || !p) throw new HttpError(404, "no such file");
  const text = readWorktreeFile(item.worktree, p);
  if (text == null) throw new HttpError(404, "no such file");
  return c.text(text);
});

itemRoutes.post("/items/:id/comment", async (c) => {
  const a = member(who(c));
  const b = await body(c, z.object({ body: z.string().min(1).max(20000) }));
  const f = await onComment(idParam(c), { source: "ui", author: name(a), body: b.body });
  return c.json(f ?? { ok: true });
});

itemRoutes.post("/items/:id/approve", async (c) => {
  const a = await approver(member(who(c)));
  const b = await body(c, z.object({ note: z.string().max(2000).optional() }));
  const ap = await pendingApproval(idParam(c));
  if (!ap) throw new HttpError(409, "nothing is waiting for approval");
  await decide(ap.id, "approved", { userId: a.user.id, via: "ui", name: name(a) }, b.note);
  return c.json(await mustItem(ap.item_id));
});

itemRoutes.post("/items/:id/reject", async (c) => {
  const a = await approver(member(who(c)));
  const b = await body(c, z.object({ note: z.string().max(2000).optional() }));
  const ap = await pendingApproval(idParam(c));
  if (!ap) throw new HttpError(409, "nothing is waiting for approval");
  await decide(ap.id, "rejected", { userId: a.user.id, via: "ui", name: name(a) }, b.note);
  return c.json(await mustItem(ap.item_id));
});

itemRoutes.post("/items/:id/review", async (c) => {
  const a = await approver(member(who(c)));
  const b = await body(c, z.object({ decision: z.enum(["approved", "changes_requested"]), body: z.string().max(20000).optional() }));
  const id = idParam(c);
  try { await reviewDecision(id, b.decision, b.body ?? "", { userId: a.user.id, via: "ui", name: name(a) }); }
  catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); }
  return c.json(await mustItem(id));
});

itemRoutes.post("/items/:id/cancel", async (c) => { const a = member(who(c)); return c.json(await cancel(idParam(c), { name: name(a) })); });
itemRoutes.post("/items/:id/retry", async (c) => {
  const a = member(who(c));
  try { return c.json(await retry(idParam(c), { name: name(a) })); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); }
});
itemRoutes.post("/items/:id/nudge", async (c) => {
  const a = await approver(member(who(c)));
  const b = await body(c, z.object({ action: z.enum(["approve_gate", "mark_done", "skip_review"]) }));
  try { return c.json(await nudge(idParam(c), b.action, { userId: a.user.id, via: "ui", name: name(a) })); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); }
});
itemRoutes.post("/items/:id/note", async (c) => {
  const a = member(who(c));
  const b = await body(c, z.object({ message: z.string().min(1).max(4000) }));
  return c.json(await emit({ itemId: idParam(c), type: "note", message: b.message, actor: name(a) }));
});

itemRoutes.get("/runs/:id", async (c) => { const r = await getRun(idParam(c)); if (!r) throw new HttpError(404, "no such run"); return c.json(r); });
itemRoutes.get("/runs/:id/events", async (c) => c.json(await listRunEvents(idParam(c), Number(c.req.query("after") || 0))));
itemRoutes.get("/approvals", async (c) => c.json(await listPendingApprovals()));
itemRoutes.get("/activity", async (c) => c.json(await recentEvents(Number(c.req.query("limit") || 100))));

/** Live events: everything, or one item's. */
itemRoutes.get("/events/stream", (c) => {
  const itemId = c.req.query("item") ? Number(c.req.query("item")) : null;
  const lastId = Number(c.req.header("last-event-id") || c.req.query("after") || 0);
  return streamSSE(c, async (stream) => {
    let open = true;
    let replayedUpTo = lastId; // everything up to here was sent by the replay; live events are never filtered by id (they arrive out of order)
    let replaying = lastId > 0;
    const held: Ev[] = []; // live events that arrive while the replay query runs: sent after it, in order
    const write = (e: Ev) => { if (!open) return; stream.writeSSE({ event: "event", data: JSON.stringify(e), id: String(e.id) }).catch(() => {}); };
    const send = (e: Ev) => { if (!open) return; if (itemId && e.item_id !== itemId) return; if (replaying) { if (held.length < 5000) held.push(e); } else write(e); };
    const off = subscribe(send);
    stream.onAbort(() => { open = false; off(); });
    try {
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ at: new Date().toISOString() }) });
      // A reconnecting browser says where it got to; replay what it missed before going live.
      if (replaying) {
        const missed = itemId ? await listEvents(itemId, lastId, 5000) : await q<Ev>("select * from events where id > $1 order by id limit 2000", [lastId]);
        for (const e of missed) { write(e); if (e.id > replayedUpTo) replayedUpTo = e.id; }
        replaying = false;
        for (const e of held.sort((a, b) => a.id - b.id)) if (e.id > replayedUpTo) write(e);
        held.length = 0;
      }
      while (open) {
        await stream.sleep(25000);
        if (open) await stream.writeSSE({ event: "ping", data: "" }).catch(() => { open = false; });
      }
    } finally {
      open = false;
      off();
      held.length = 0;
    }
  });
});
