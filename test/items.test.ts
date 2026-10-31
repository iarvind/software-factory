import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, useTestDb } from "./helpers.ts";

describe("items, approvals, feedback", { skip: skipIfNoDb }, () => {
  let db: Awaited<ReturnType<typeof useTestDb>>;
  let items: typeof import("../server/lib/items.ts");
  before(async () => {
    db = await useTestDb();
    items = await import("../server/lib/items.ts");
  });
  after(async () => { await db?.close(); });

  const statusEvents = (itemId: number) => db.q<{ message: string; data: { status: string; gate: string | null }; actor: string; level: string }>("select message, data, actor, level from events where item_id = $1 and type = 'status' order by id", [itemId]);

  test("createItem: defaults, and an arrival event", async () => {
    const { item, created } = await items.createItem({ title: "  Add a dark mode  ", body: "please", priority: 9 }, "ada");
    assert.equal(created, true);
    assert.equal(item.title, "Add a dark mode");
    assert.equal(item.status, "inbox");
    assert.equal(item.priority, 5, "priority is clamped to 1–5");
    assert.deepEqual(item.origin, { kind: "manual" });
    assert.deepEqual(item.labels, []);
    const ev = await statusEvents(item.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].message, "arrived: Add a dark mode");
    assert.equal(ev[0].data.status, "inbox");
    assert.equal(ev[0].actor, "ada");
  });

  test("createItem: the same external id from the same source is one item", async () => {
    const [src] = await db.q<{ id: number }>("insert into sources (kind, name) values ('webhook', 'hook') returning id");
    const [src2] = await db.q<{ id: number }>("insert into sources (kind, name) values ('webhook', 'other') returning id");
    const a = await items.createItem({ title: "From a hook", sourceId: src.id, externalId: "ext-1", origin: { kind: "webhook", sourceId: src.id } });
    const b = await items.createItem({ title: "From a hook, again", sourceId: src.id, externalId: "ext-1" });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.item.id, a.item.id);
    assert.equal(b.item.title, "From a hook");
    const c = await items.createItem({ title: "Same id, other source", sourceId: src2.id, externalId: "ext-1" });
    assert.equal(c.created, true);
    assert.notEqual(c.item.id, a.item.id);
    const d = await items.createItem({ title: "No external id", sourceId: src.id });
    const e = await items.createItem({ title: "No external id", sourceId: src.id });
    assert.notEqual(d.item.id, e.item.id, "without an external id nothing is deduplicated");
  });

  test("setStatus: every change is an event; timestamps and errors follow the status", async () => {
    const { item } = await items.createItem({ title: "Status walk" });
    assert.equal(item.started_at, null);
    let it = await items.setStatus(item.id, "planning", { message: "reading", actor: "factory" });
    assert.ok(it.started_at, "started when it leaves the inbox");
    it = await items.setStatus(item.id, "awaiting_approval", { gate: "plan" });
    assert.equal(it.gate, "plan");
    it = await items.setStatus(item.id, "blocked", { error: "it broke" });
    assert.equal(it.error, "it broke");
    assert.equal(it.gate, null);
    assert.equal(it.finished_at, null);
    it = await items.setStatus(item.id, "fixing");
    assert.equal(it.error, "it broke", "the error stays until the item is queued, building or done");
    it = await items.setStatus(item.id, "queued");
    assert.equal(it.error, null);
    it = await items.setStatus(item.id, "done", { message: "merged", data: { sha: "abc" } });
    assert.ok(it.finished_at);
    const ev = await statusEvents(item.id);
    assert.deepEqual(ev.map((e) => e.data.status), ["inbox", "planning", "awaiting_approval", "blocked", "fixing", "queued", "done"]);
    assert.equal(ev[2].data.gate, "plan");
    assert.equal(ev[3].level, "error");
    assert.equal(ev[6].message, "merged");
    assert.equal((ev[6].data as unknown as { sha: string }).sha, "abc");
    await assert.rejects(items.setStatus(item.id, "queued"), items.ItemClosed, "a closed item does not move by accident");
    it = await items.setStatus(item.id, "queued", { force: true });
    assert.equal(it.finished_at, null, "reopening (on purpose) clears finished_at");
  });

  test("approvals: request, supersede, decide once", async () => {
    const { item } = await items.createItem({ title: "Gate" });
    const a1 = await items.requestApproval(item.id, "plan", "first plan", { steps: ["a"] });
    assert.equal(a1.status, "pending");
    assert.deepEqual(a1.payload, { steps: ["a"] });
    assert.equal((await items.pendingApproval(item.id))?.id, a1.id);
    const a2 = await items.requestApproval(item.id, "plan", "second plan");
    const all = await items.approvalsFor(item.id);
    assert.deepEqual(all.map((a) => [a.id, a.status]), [[a1.id, "expired"], [a2.id, "pending"]], "a new request expires the old one");
    assert.equal(all[0].decided_at !== null, true);
    assert.equal((await items.pendingApproval(item.id))?.id, a2.id);
    assert.ok((await items.listPendingApprovals()).some((a) => a.id === a2.id && a.title === "Gate"));
    await assert.rejects(items.decideApproval(a1.id, "approved", { via: "test" }), (e: Error & { status?: number }) => e.status === 409);
    const d = await items.decideApproval(a2.id, "approved", { via: "test", name: "ada" }, "looks good");
    assert.equal(d.status, "approved");
    assert.equal(d.note, "looks good");
    assert.equal(d.decided_via, "test");
    await assert.rejects(items.decideApproval(a2.id, "rejected", { via: "test" }), /already decided/);
    assert.equal(await items.pendingApproval(item.id), null);
    const ev = await db.q<{ message: string }>("select message from events where item_id = $1 and type = 'approval' order by id", [item.id]);
    assert.deepEqual(ev.map((e) => e.message), ["approval requested: plan", "approval requested: plan", "plan approved: looks good"]);
  });

  test("approvals: closing an item expires what was waiting", async () => {
    const { item } = await items.createItem({ title: "Closed while waiting" });
    const a = await items.requestApproval(item.id, "merge", "merge it?");
    await items.setStatus(item.id, "cancelled");
    assert.equal(await items.pendingApproval(item.id), null);
    assert.equal((await items.approvalsFor(item.id))[0].status, "expired");
    await assert.rejects(items.decideApproval(a.id, "approved", { via: "test" }), /already decided or has expired/);
  });

  test("feedback: deduplicated by external id per source; handled once", async () => {
    const { item } = await items.createItem({ title: "Feedback" });
    const f1 = await items.addFeedback(item.id, { source: "slack", author: "ada", body: "make it blue", externalId: "ts-1" });
    assert.ok(f1);
    assert.equal(f1.kind, "comment");
    assert.equal(await items.addFeedback(item.id, { source: "slack", author: "ada", body: "make it blue", externalId: "ts-1" }), null);
    assert.ok(await items.addFeedback(item.id, { source: "github", body: "same id elsewhere", externalId: "ts-1" }), "another source may reuse the id");
    assert.ok(await items.addFeedback(item.id, { source: "ui", body: "no id", kind: "changes_requested" }));
    assert.ok(await items.addFeedback(item.id, { source: "ui", body: "no id" }), "without an id, every one counts");
    assert.equal((await items.feedbackFor(item.id)).length, 4);
    const open = await items.unhandledFeedback(item.id);
    assert.equal(open.length, 4);
    await items.markHandled([open[0].id, open[1].id]);
    assert.deepEqual((await items.unhandledFeedback(item.id)).map((f) => f.id), [open[2].id, open[3].id]);
    await items.markHandled([]);
    const ev = await db.q<{ message: string; actor: string }>("select message, actor from events where item_id = $1 and type = 'feedback' order by id", [item.id]);
    assert.equal(ev.length, 4);
    assert.deepEqual(ev[0], { message: "make it blue", actor: "ada" });
  });

  test("listItems: filters", async () => {
    const open = await items.listItems({ open: true });
    assert.ok(open.every((i) => items.OPEN.includes(i.status)));
    assert.ok((await items.listItems({ status: ["cancelled"] })).every((i) => i.status === "cancelled"));
    assert.equal((await items.listItems({ q: "dark mode" }))[0]?.title, "Add a dark mode");
    assert.equal((await items.listItems({ limit: 2 })).length, 2);
  });
});
