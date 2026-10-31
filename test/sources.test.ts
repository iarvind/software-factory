// The source scheduler and the built-in kinds against the test database: one open item at a time
// for schedules and watches, a schedule that must be given its timing, a long-lived source whose
// start fails (retried, shown as an error), and the later-request lookups adapters rely on.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, useTestDb } from "./helpers.ts";
import type { SourceContext, SourceRow } from "../server/lib/sources/index.ts";

process.env.NOTIFIER_URL = "";

describe("sources: scheduling, one open item, live connections", { skip: skipIfNoDb }, () => {
  let db: Awaited<ReturnType<typeof useTestDb>>;
  let sources: typeof import("../server/lib/sources/index.ts");

  before(async () => {
    db = await useTestDb();
    sources = await import("../server/lib/sources/index.ts");
    (await import("../server/lib/sources/builtin.ts")).registerBuiltinSources();
  });
  beforeEach(async () => { await db.reset(); });
  after(async () => { await sources?.stopSources(); await db?.close(); });

  const count = async () => (await db.q<{ n: number }>("select count(*)::int as n from work_items"))[0].n;
  const fresh = async (id: number) => (await sources.getSource(id))!;
  const schedule = { title: "Nightly: read the error log", body: "Fix what it complains about." };

  test("a schedule needs a cron expression or an interval; one without is never polled", async () => {
    await assert.rejects(sources.createSource({ kind: "schedule", name: "nightly", projectId: null, config: schedule, secrets: {} }), /a schedule needs a cron expression or an interval/);
    const src = await sources.createSource({ kind: "schedule", name: "nightly", projectId: null, config: schedule, secrets: {}, cron: "30 2 * * *" });
    await assert.rejects(sources.updateSource(src.id, { cron: null }), /a schedule needs a cron expression or an interval/);
    await sources.updateSource(src.id, { cron: null, intervalSec: 3600 }); // swapping one timing for the other is fine
    await sources.updateSource(src.id, { intervalSec: null, enabled: false }); // switched off, it may wait without one

    // A row from before the check: the scheduler leaves it alone instead of running it every five minutes.
    const [legacy] = await db.q<SourceRow>("insert into sources (kind, name, config) values ('schedule', 'old', $1) returning *", [JSON.stringify(schedule)]);
    await sources.pollSource(legacy);
    assert.equal((await fresh(legacy.id)).last_polled_at, null);
    assert.equal(await count(), 0);
  });

  test("a schedule skips its run while an earlier run's item is open", async () => {
    const src = await sources.createSource({ kind: "schedule", name: "nightly", projectId: null, config: schedule, secrets: {}, intervalSec: 3600 });
    await sources.pollSource(src, true);
    const [first] = await db.q<{ id: number; external_id: string }>("select id, external_id from work_items");
    assert.match(first.external_id, /^run:\d{4}-\d\d-\d\dT\d\d:\d\d$/);
    // An earlier run (another external id), still being worked on.
    await db.q("update work_items set external_id = 'run:2026-10-30T02:30', status = 'building' where id = $1", [first.id]);
    await sources.pollSource(await fresh(src.id), true);
    assert.equal(await count(), 1);
    assert.equal((await fresh(src.id)).last_error, null);
    await db.q("update work_items set status = 'done' where id = $1", [first.id]);
    await sources.pollSource(await fresh(src.id), true);
    assert.equal(await count(), 2);
  });

  test("a watch that keeps firing raises one item until that one closes", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;
    try {
      const src = await sources.createSource({ kind: "watch", name: "health", projectId: null, secrets: {}, intervalSec: 60, config: { url: "http://127.0.0.1:9/healthz", condition: "status_not_2xx", title: "The health check fails", body: "Find out why." } });
      await sources.pollSource(src, true);
      await sources.pollSource(await fresh(src.id), true);
      await sources.pollSource(await fresh(src.id), true);
      assert.equal(await count(), 1);
      await db.q("update work_items set status = 'cancelled'");
      await sources.pollSource(await fresh(src.id), true);
      assert.equal(await count(), 2);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("latestItem finds a ticket's newest request, later ones as ref#2, and no other ticket's", async () => {
    const [src] = await db.q<SourceRow>("insert into sources (kind, name) values ('webhook', 'tickets') returning *");
    const ctx = sources.contextFor(src);
    for (const [ext, status] of [["ENG-4", "done"], ["ENG-4#2", "queued"], ["ENG-42", "queued"], ["ENG-4x", "queued"]]) {
      await db.q("insert into work_items (source_id, external_id, title, status) values ($1, $2, $2, $3)", [src.id, ext, status]);
    }
    assert.equal((await ctx.latestItem("ENG-4"))?.external_id, "ENG-4#2");
    await db.q("update work_items set status = 'done' where external_id = 'ENG-4#2'");
    await db.q("update work_items set status = 'queued' where external_id = 'ENG-4'");
    assert.equal((await ctx.latestItem("ENG-4"))?.external_id, "ENG-4", "an open one comes first");
    assert.equal((await ctx.latestItem("ENG-5")), null);
    assert.equal((await ctx.openItem())?.status, "queued");
  });

  test("a long-lived source that cannot start shows an error and is tried again later; setError marks a running one", async () => {
    let calls = 0, fail = true;
    let running: SourceContext | null = null;
    sources.registerSource({
      kind: "test-live", label: "Live (test)", description: "test", fields: [], defaultIntervalSec: null,
      async start(ctx) { calls++; if (fail) throw new Error("service_unavailable"); running = ctx; return async () => {}; },
    });
    const [row] = await db.q<{ id: number }>("insert into sources (kind, name) values ('test-live', 'one') returning id");
    await sources.scanSources();
    assert.equal(calls, 1);
    assert.equal(sources.liveStatus(row.id), "error");
    assert.match((await fresh(row.id)).last_error ?? "", /service_unavailable/);
    await sources.scanSources();
    assert.equal(calls, 1, "not again before a minute has passed");

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      fail = false;
      await sources.scanSources();
    } finally {
      Date.now = realNow;
    }
    assert.equal(calls, 2);
    assert.equal(sources.liveStatus(row.id), "connected");
    assert.equal((await fresh(row.id)).last_error, null);

    await running!.setError("slack auth.test: invalid_auth: fix the tokens");
    assert.equal(sources.liveStatus(row.id), "error");
    assert.match((await fresh(row.id)).last_error ?? "", /invalid_auth/);
    await running!.setError(null);
    assert.equal(sources.liveStatus(row.id), "connected");
    assert.equal((await fresh(row.id)).last_error, null);
  });
});
