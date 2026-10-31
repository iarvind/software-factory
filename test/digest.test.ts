// The daily digest's text, and broadcast() which carries it to every source that has a place for it.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, useTestDb } from "./helpers.ts";
import type { SourceAdapter, SourceContext } from "../server/lib/sources/index.ts";

process.env.NOTIFIER_URL = "";

describe("daily digest and broadcast", { skip: skipIfNoDb }, () => {
  let db: Awaited<ReturnType<typeof useTestDb>>;
  let digest: typeof import("../server/lib/digest.ts");
  let sources: typeof import("../server/lib/sources/index.ts");

  before(async () => {
    db = await useTestDb();
    digest = await import("../server/lib/digest.ts");
    sources = await import("../server/lib/sources/index.ts");
  });
  beforeEach(async () => { await db.reset(); });
  after(async () => { await db?.close(); });

  test("digestText names what shipped in the last day, what waits on a person, and what it cost", async () => {
    const [p] = await db.q<{ id: number }>("insert into projects (slug, name, local_path) values ('shop', 'Shop', '/nowhere') returning id");
    const [shipped] = await db.q<{ id: number }>("insert into work_items (project_id, title, status, created_at, finished_at) values ($1, 'Add a receipt page', 'done', now() - interval '5 hours', now() - interval '2 hours') returning id", [p.id]);
    const [waiting] = await db.q<{ id: number }>("insert into work_items (project_id, title, status, gate, created_at, updated_at) values ($1, 'Rename the cart', 'awaiting_approval', 'merge', now() - interval '4 hours', now() - interval '3 hours') returning id", [p.id]);
    // Last week's work is not today's news, and neither is its cost.
    const [old] = await db.q<{ id: number }>("insert into work_items (project_id, title, status, created_at, finished_at) values ($1, 'An old change', 'done', now() - interval '4 days', now() - interval '3 days') returning id", [p.id]);
    await db.q(
      `insert into runs (item_id, kind, runner, status, cost_usd, started_at, finished_at) values
         ($1, 'build', 'fake', 'succeeded', 0.40, now() - interval '3 hours', now() - interval '2 hours'),
         ($2, 'build', 'fake', 'succeeded', 0.35, now() - interval '4 hours', now() - interval '3 hours'),
         ($3, 'build', 'fake', 'succeeded', 5.00, now() - interval '3 days', now() - interval '3 days')`,
      [shipped.id, waiting.id, old.id],
    );

    const d = await digest.digestText();
    assert.equal(d.title, "Factory, the daily word");
    const lines = d.text.split("\n");
    assert.equal(lines[0], "Last 24 h: 2 arrived, 1 shipped, $0.75 API-equivalent ($0.75 per shipped change).");
    assert.ok(lines.includes("Shipped:"), d.text);
    assert.ok(lines.includes(`• #${shipped.id} Add a receipt page (Shop)`), d.text);
    assert.ok(lines.includes("Waiting on a person:"), d.text);
    assert.ok(lines.includes(`• #${waiting.id} Rename the cart — merge approval, 3 h`), d.text);
    assert.ok(lines.indexOf("Shipped:") < lines.indexOf("Waiting on a person:"));
    assert.doesNotMatch(d.text, /An old change|\$5\.|Nothing is waiting/);
  });

  test("digestText on a quiet day", async () => {
    const d = await digest.digestText();
    assert.equal(d.text, "Last 24 h: 0 arrived, 0 shipped, $0.00 API-equivalent.\n\nNothing is waiting on a person.");
  });

  test("broadcast goes through enabled sources whose adapter can broadcast, and counts the ones that did", async () => {
    const heard: Array<{ source: string; text: string }> = [];
    const adapter = (kind: string, broadcast?: SourceAdapter["broadcast"]): SourceAdapter => ({ kind, label: kind, description: `${kind} (test)`, fields: [], defaultIntervalSec: null, ...(broadcast ? { broadcast } : {}) });
    sources.registerSource(adapter("test-bcast", async (ctx: SourceContext, text: string) => { heard.push({ source: ctx.source.name, text }); return true; }));
    sources.registerSource(adapter("test-nowhere", async () => false)); // has the hook, but no place to post this time
    sources.registerSource(adapter("test-aaa-broken", async () => { throw new Error("socket closed"); })); // visited first: sources go by kind
    sources.registerSource(adapter("test-mute")); // cannot broadcast at all
    await db.q(
      `insert into sources (kind, name, enabled) values
         ('test-bcast', 'on', true), ('test-bcast', 'off', false), ('test-nowhere', 'quiet', true),
         ('test-aaa-broken', 'broken', true), ('test-mute', 'mute', true), ('not-registered', 'orphan', true)`,
    );

    const n = await sources.broadcast("*Factory, the daily word*\nAll quiet.");
    assert.equal(n, 1);
    assert.deepEqual(heard, [{ source: "on", text: "*Factory, the daily word*\nAll quiet." }], "the disabled source of the same kind heard nothing");
    const warns = await db.q<{ message: string; level: string }>("select message, level from events where type = 'system' order by id");
    assert.deepEqual(warns, [{ message: "[test-aaa-broken:broken] broadcast failed: socket closed", level: "warn" }], "a source that throws is reported and does not stop the others");
  });
});
