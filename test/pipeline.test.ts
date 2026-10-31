// The factory floor end to end, against the test database, with the fake runner and a real git
// repository per scenario (delivery "local", `npm test` as the verification). The pipeline is
// driven by calling tick() in a polling loop, as the server's interval would.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitIn, skipIfNoDb, sleep, tempDir, tempRepo, useTestDb } from "./helpers.ts";
import type { Item } from "../server/lib/items.ts";

let DATA = "";
process.env.RUNNER = "fake";
process.env.NOTIFIER_URL = "";
process.env.MAX_CONCURRENT_RUNS = "2";

describe("pipeline end to end (fake runner)", { skip: skipIfNoDb }, () => {
  let db: Awaited<ReturnType<typeof useTestDb>>;
  let pipeline: typeof import("../server/lib/pipeline.ts");
  let items: typeof import("../server/lib/items.ts");
  let fake: typeof import("../server/lib/runners/fake.ts");
  const repos: string[] = [];
  const touched = new Set<number>();
  const by = { via: "test", name: "tester" };

  before(async () => {
    DATA = tempDir("factory-data-");
    process.env.FACTORY_DATA = DATA; // before git.ts is imported: worktrees go here
    db = await useTestDb();
    const runners = await import("../server/lib/runners/index.ts");
    fake = await import("../server/lib/runners/fake.ts");
    runners.registerRunner(fake.fakeRunner);
    pipeline = await import("../server/lib/pipeline.ts");
    items = await import("../server/lib/items.ts");
  });

  after(async () => {
    for (const id of touched) await quiet(id).catch(() => {});
    await db?.close();
    for (const d of [...repos, DATA].filter(Boolean)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function project(slug: string, o: { failing?: boolean; test?: string; gates?: Record<string, string>; limits?: Record<string, number> } = {}) {
    const repo = tempRepo({ failing: o.failing, test: o.test });
    repos.push(repo);
    const [p] = await db.q<{ id: number }>(
      `insert into projects (slug, name, local_path, default_branch, runner, test_command, delivery, gates, limits, tools)
       values ($1, $1, $2, 'main', 'fake', 'npm test', 'local', $3, $4, $5) returning id`,
      [slug, repo, JSON.stringify({ plan: "manual", merge: "manual", deploy: "off", review: "off", ...o.gates }), JSON.stringify(o.limits ?? {}), JSON.stringify({ mode: "edit", allow: [], deny: [] })],
    );
    return { id: p.id, repo, slug };
  }

  async function newItem(projectId: number, title: string): Promise<Item> {
    const { item } = await items.createItem({ title, body: `Please: ${title.toLowerCase()}.`, projectId, requesterName: "requester" });
    touched.add(item.id);
    return item;
  }

  /** Ticks and polls every 100 ms until the item satisfies `pred` (30 s at most). */
  async function until(id: number, pred: (it: Item) => boolean, what: string, onPoll?: (it: Item) => Promise<void> | void): Promise<Item> {
    const end = Date.now() + 30_000;
    for (;;) {
      await pipeline.tick();
      const it = (await items.getItem(id))!;
      await onPoll?.(it);
      if (pred(it)) return it;
      if (Date.now() > end) throw new Error(`timed out waiting for #${id} to be ${what}; it is ${it.status}${it.error ? ` (${it.error})` : ""}`);
      await sleep(100);
    }
  }

  /** Until nothing is running for the item and its timeline has been still for half a second. */
  async function quiet(id: number): Promise<void> {
    const end = Date.now() + 30_000;
    let last = -1, still = Date.now();
    for (;;) {
      const [{ n }] = await db.q<{ n: number }>("select count(*)::int as n from events where item_id = $1", [id]);
      if (n !== last) { last = n; still = Date.now(); }
      else if (!pipeline.isActive(id) && Date.now() - still > 500) return;
      if (Date.now() > end) throw new Error(`#${id} never went quiet`);
      await sleep(100);
    }
  }

  async function approvePlan(id: number): Promise<void> {
    await until(id, (i) => i.status === "awaiting_approval", "waiting for the plan approval");
    await pipeline.decide((await items.pendingApproval(id))!.id, "approved", by);
  }

  const statuses = async (id: number) => (await db.q<{ s: string }>("select data->>'status' as s from events where item_id = $1 and type = 'status' order by id", [id])).map((r) => r.s);
  const runs = async (id: number) => (await items.runsFor(id)).map((r) => `${r.kind}:${r.status}`);
  const verifies = async (id: number) => (await db.q<{ level: string; message: string }>("select level, message from events where item_id = $1 and type = 'verify' order by id", [id]));

  test("a: plan, approve, build, verify, review, approve the merge, done", async () => {
    fake.setFakeBehaviour({});
    const p = await project("alpha");
    const item = await newItem(p.id, "Add a notes file");

    let it = await until(item.id, (i) => i.status === "awaiting_approval", "waiting for the plan approval");
    assert.equal(it.gate, "plan");
    assert.equal(it.plan?.summary, "Implement: Add a notes file");
    assert.equal(it.kind, "feature");
    assert.ok(it.worktree && fs.existsSync(it.worktree), "the plan ran in the job's worktree");
    assert.equal(it.branch, `factory/${item.id}-add-a-notes-file`);
    const planGate = await items.pendingApproval(item.id);
    assert.equal(planGate?.kind, "plan");
    assert.equal(pipeline.isActive(item.id), false, "nothing holds a slot while a person decides");

    await pipeline.decide(planGate!.id, "approved", by, "go");
    assert.equal((await items.getItem(item.id))!.status, "queued");
    it = await until(item.id, (i) => i.status === "review", "in review");
    assert.ok(fs.existsSync(path.join(it.worktree!, "FACTORY_NOTES.md")));
    assert.ok(it.head_sha && it.head_sha !== it.base_sha, "the build left a commit");
    assert.deepEqual((await verifies(item.id)).map((v) => v.level), ["info"]);
    assert.match((await verifies(item.id))[0].message, /^passed: npm test/);

    await pipeline.reviewDecision(item.id, "approved", "looks right", by);
    it = (await items.getItem(item.id))!;
    assert.equal(it.status, "awaiting_approval");
    assert.equal(it.gate, "merge");
    const mergeGate = await items.pendingApproval(item.id);
    assert.equal(mergeGate?.kind, "merge");

    await pipeline.decide(mergeGate!.id, "approved", by);
    it = await until(item.id, (i) => i.status === "done", "done");
    await quiet(item.id);

    assert.equal(gitIn(p.repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.match(gitIn(p.repo, "show", "main:FACTORY_NOTES.md"), /Add a notes file \(fake runner\)/);
    assert.match(gitIn(p.repo, "log", "-1", "--format=%s", "main"), new RegExp(`^Merge #${item.id}: Add a notes file`));
    assert.equal(gitIn(p.repo, "status", "--porcelain"), "", "the live checkout is clean");
    assert.deepEqual(await statuses(item.id), ["inbox", "planning", "awaiting_approval", "queued", "building", "verifying", "review", "awaiting_approval", "merging", "done"]);
    assert.deepEqual(await runs(item.id), ["plan:succeeded", "build:succeeded", "learn:succeeded"]);
    const build = (await items.runsFor(item.id))[1];
    const timeline = await db.q<{ type: string; message: string }>("select type, message from events where run_id = $1 order by id", [build.id]);
    assert.deepEqual(timeline.map((e) => e.type), ["run", "log", "tool", "tool_result", "tool", "tool_result", "text", "run"], "a run's events keep the order the runner said them in");
    assert.match(timeline[2].message, /^Write: /);
    assert.match(timeline.at(-1)!.message, /^build run succeeded/);
    it = (await items.getItem(item.id))!;
    assert.equal(it.worktree, null, "the worktree is dropped when the job is done");
    assert.ok(!fs.existsSync(path.join(DATA, "work", "alpha", String(item.id))));
    assert.ok(it.finished_at);
    assert.ok(it.cost_usd > 0 && it.turns > 0);
    const notes = await db.q<{ body: string }>("select body from notes where item_id = $1", [item.id]);
    assert.equal(notes.length, 1, "what was learned went into the book");
    assert.deepEqual((await items.approvalsFor(item.id)).map((a) => `${a.kind}:${a.status}`), ["plan:approved", "merge:approved"]);
    assert.equal(pipeline.isActive(item.id), false);
  });

  test("b: a question for the requester, answered, and the plan goes on", async () => {
    fake.setFakeBehaviour({ needsInfo: true });
    const p = await project("bravo");
    const item = await newItem(p.id, "Show the build number");
    let it = await until(item.id, (i) => i.status === "needs_info", "waiting for an answer");
    assert.deepEqual(it.plan?.questions, ["Which page should this appear on?"]);
    assert.equal(await items.pendingApproval(item.id), null);

    await pipeline.onComment(item.id, { source: "test", author: "requester", body: "On the settings page" });
    it = (await items.getItem(item.id))!;
    assert.equal(it.status, "inbox");
    fake.setFakeBehaviour({});
    it = await until(item.id, (i) => i.status === "awaiting_approval", "waiting for the plan approval");
    assert.equal(it.plan?.clarity, "clear");
    await quiet(item.id);

    assert.deepEqual(await statuses(item.id), ["inbox", "planning", "needs_info", "inbox", "planning", "awaiting_approval"]);
    const all = await items.runsFor(item.id);
    assert.deepEqual(all.map((r) => r.kind), ["plan", "plan"]);
    assert.equal(all[1].session_id, all[0].session_id, "the second plan resumed the first session");
    const second = await db.q<{ prompt: string }>("select prompt from runs where id = $1", [all[1].id]);
    assert.match(second[0].prompt, /The requester answered:\n- requester \(answer\): On the settings page/);
    const fb = await items.feedbackFor(item.id);
    assert.equal(fb.length, 1);
    assert.equal(fb[0].kind, "answer");
    assert.ok(fb[0].handled_at, "the answer was used");
  });

  test("c: tests that keep failing end the job blocked", async () => {
    fake.setFakeBehaviour({});
    const p = await project("charlie", { failing: true, limits: { maxFixRounds: 1 } });
    const item = await newItem(p.id, "Break nothing");
    await until(item.id, (i) => i.status === "awaiting_approval", "waiting for the plan approval");
    await pipeline.decide((await items.pendingApproval(item.id))!.id, "approved", by);

    // The verification after the fix round still runs inside the job: the item must hold its slot (cancel aborts it, and the concurrency count sees it).
    let unreserved = false;
    const it = await until(item.id, (i) => i.status === "blocked", "blocked", async (i) => {
      if (i.status !== "verifying" || i.verify_rounds !== 1 || pipeline.isActive(i.id)) return;
      const again = (await items.getItem(i.id))!;
      if (again.status === "verifying" && again.verify_rounds === 1 && !pipeline.isActive(i.id)) unreserved = true;
    });
    await quiet(item.id);
    assert.equal(unreserved, false, "the job let go of its slot while it was still verifying");
    assert.match(it.error ?? "", /verification still fails after 1 fix rounds: npm test failed \(exit 1\)/);
    assert.equal(it.verify_rounds, 2);
    assert.deepEqual(await statuses(item.id), ["inbox", "planning", "awaiting_approval", "queued", "building", "verifying", "fixing", "verifying", "blocked"]);
    assert.deepEqual(await runs(item.id), ["plan:succeeded", "build:succeeded", "fix:succeeded"]);
    const all = await items.runsFor(item.id);
    assert.equal(all[2].session_id, all[1].session_id, "the fix resumed the build session");
    assert.deepEqual((await verifies(item.id)).map((v) => v.level), ["error", "error"]);
    assert.ok(it.worktree && fs.existsSync(it.worktree), "a blocked job keeps its worktree for a retry");
    assert.equal(pipeline.isActive(item.id), false);
    const errs = await db.q<{ message: string }>("select message from events where item_id = $1 and type = 'error'", [item.id]);
    assert.equal(errs.length, 1);
  });

  test("d: cancelling while a gate waits removes the worktree and the gate", async () => {
    fake.setFakeBehaviour({});
    const p = await project("delta");
    const item = await newItem(p.id, "Never mind");
    let it = await until(item.id, (i) => i.status === "awaiting_approval", "waiting for the plan approval");
    const worktree = it.worktree!;
    assert.ok(fs.existsSync(worktree));
    const gate = (await items.pendingApproval(item.id))!;

    it = await pipeline.cancel(item.id, { name: "tester" });
    await quiet(item.id);
    assert.equal(it.status, "cancelled");
    assert.equal(it.worktree, null);
    assert.ok(!fs.existsSync(worktree), "the worktree directory is gone");
    assert.ok(!gitIn(p.repo, "worktree", "list").includes(worktree), "and git no longer lists it");
    assert.equal(await items.pendingApproval(item.id), null, "nothing waits for a decision on a cancelled item");
    await assert.rejects(pipeline.decide(gate.id, "approved", by), /expired/);
    await until(item.id, () => true, "ticked");
    assert.equal((await items.getItem(item.id))!.status, "cancelled", "and nothing brings it back");
    assert.deepEqual((await statuses(item.id)).slice(-2), ["awaiting_approval", "cancelled"]);
  });

  test("e: automatic gates go straight through to done", async () => {
    fake.setFakeBehaviour({});
    const p = await project("echo", { gates: { plan: "auto", merge: "auto" } });
    const item = await newItem(p.id, "Ship it alone");
    await until(item.id, (i) => i.status === "done", "done");
    await quiet(item.id);
    assert.deepEqual(await items.approvalsFor(item.id), [], "no approval was asked for");
    assert.deepEqual(await statuses(item.id), ["inbox", "planning", "queued", "building", "verifying", "merging", "done"]);
    assert.match(gitIn(p.repo, "show", "main:FACTORY_NOTES.md"), /Ship it alone/);
    assert.deepEqual(await runs(item.id), ["plan:succeeded", "build:succeeded", "learn:succeeded"]);
    assert.equal((await items.getItem(item.id))!.worktree, null);
  });

  test("f: a comment made during the build starts a fix round once the item reaches review", async () => {
    fake.setFakeBehaviour({ delayMs: 1500 });
    const p = await project("foxtrot", { limits: { maxFixRounds: 2 } });
    const item = await newItem(p.id, "Write the changelog");
    await until(item.id, (i) => i.status === "awaiting_approval", "waiting for the plan approval");
    await pipeline.decide((await items.pendingApproval(item.id))!.id, "approved", by);
    await until(item.id, (i) => i.status === "building", "building");
    await pipeline.onComment(item.id, { source: "test", author: "reviewer", body: "Also mention the date" });

    const it = await until(item.id, (i) => i.status === "review" && i.fix_rounds === 1, "back in review after a fix round");
    await quiet(item.id);
    fake.setFakeBehaviour({});
    assert.equal((await items.getItem(item.id))!.status, "review", "one round answers the comment; it then waits for a person");
    assert.deepEqual(await runs(item.id), ["plan:succeeded", "build:succeeded", "fix:succeeded"]);
    const fix = (await items.runsFor(item.id))[2];
    const prompt = await db.q<{ prompt: string }>("select prompt from runs where id = $1", [fix.id]);
    assert.match(prompt[0].prompt, /reviewer: Also mention the date/);
    assert.deepEqual(await items.unhandledFeedback(item.id), [], "the comment was acted on");
    assert.deepEqual((await statuses(item.id)).slice(-5), ["verifying", "review", "fixing", "verifying", "review"]);
    assert.equal(gitIn(it.worktree!, "rev-list", "--count", `${it.base_sha}..HEAD`), "2", "the build's commit and the fix round's");
  });

  test("g: changes requested in review are fixed and verified, then approved and merged", async () => {
    fake.setFakeBehaviour({});
    const p = await project("golf");
    const item = await newItem(p.id, "Name things well");
    await approvePlan(item.id);
    await until(item.id, (i) => i.status === "review" && i.fix_rounds === 0, "in review");
    await pipeline.reviewDecision(item.id, "changes_requested", "rename the file", { ...by, externalId: "rev-1" });
    let it = await until(item.id, (i) => i.status === "review" && i.fix_rounds === 1, "back in review after the fix");
    await quiet(item.id);
    assert.deepEqual(await runs(item.id), ["plan:succeeded", "build:succeeded", "fix:succeeded"]);
    assert.deepEqual(await items.unhandledFeedback(item.id), []);
    await pipeline.reviewDecision(item.id, "approved", "good now", by);
    await pipeline.decide((await items.pendingApproval(item.id))!.id, "approved", by);
    it = await until(item.id, (i) => i.status === "done", "done");
    await quiet(item.id);
    assert.deepEqual((await statuses(item.id)).slice(-7), ["review", "fixing", "verifying", "review", "awaiting_approval", "merging", "done"]);
    assert.equal(gitIn(p.repo, "rev-list", "--count", `${it.base_sha}..main`), "3", "the build, the fix and the merge commit");
  });

  test("h: a blocked job retried keeps its branch and runs again", async () => {
    fake.setFakeBehaviour({});
    const p = await project("hotel", { failing: true, limits: { maxFixRounds: 0 } });
    const item = await newItem(p.id, "Try twice");
    await approvePlan(item.id);
    let it = await until(item.id, (i) => i.status === "blocked", "blocked");
    await quiet(item.id);
    const firstHead = it.head_sha;
    it = await pipeline.retry(item.id, by);
    assert.equal(it.status, "queued", "a planned item goes straight back to the build queue");
    assert.equal(it.verify_rounds, 0);
    it = await until(item.id, (i) => i.status === "blocked" && i.head_sha !== firstHead, "blocked again");
    await quiet(item.id);
    assert.deepEqual(await runs(item.id), ["plan:succeeded", "build:succeeded", "build:succeeded"]);
    assert.equal(gitIn(it.worktree!, "rev-list", "--count", `${it.base_sha}..HEAD`), "2", "the second build stacked on the first");
    await pipeline.cancel(item.id, by);
    await quiet(item.id);
  });

  test("i: cancelling during the build aborts the run, and the item stays cancelled", async () => {
    fake.setFakeBehaviour({ delayMs: 3000 });
    const p = await project("india");
    const item = await newItem(p.id, "Stop me");
    fake.setFakeBehaviour({});
    await approvePlan(item.id);
    fake.setFakeBehaviour({ delayMs: 3000 });
    await until(item.id, (i) => i.status === "building" && pipeline.isActive(i.id), "building");
    const it = await pipeline.cancel(item.id, by);
    fake.setFakeBehaviour({});
    await quiet(item.id);
    assert.equal(it.status, "cancelled");
    assert.equal(pipeline.isActive(item.id), false);
    assert.deepEqual((await runs(item.id)).slice(0, 2), ["plan:succeeded", "build:cancelled"]);
    await until(item.id, () => true, "ticked");
    assert.equal((await items.getItem(item.id))!.status, "cancelled");
    assert.equal((await items.getItem(item.id))!.worktree, null);
  });

  test("j: cancelling during verification stops it, and the item stays cancelled", async () => {
    fake.setFakeBehaviour({});
    const p = await project("juliet", { test: 'node -e "setTimeout(() => {}, 4000)"' });
    const item = await newItem(p.id, "Slow tests");
    await approvePlan(item.id);
    await until(item.id, (i) => i.status === "verifying", "verifying");
    await sleep(300);
    const started = Date.now();
    const it = await pipeline.cancel(item.id, by);
    assert.ok(Date.now() - started < 3000, "the test command was stopped, not waited out");
    await quiet(item.id);
    assert.equal(it.status, "cancelled");
    const after = (await items.getItem(item.id))!;
    assert.equal(after.status, "cancelled", "verification finishing must not move a cancelled item on");
    assert.deepEqual((await statuses(item.id)).slice(-2), ["verifying", "cancelled"]);
    assert.equal(after.worktree, null);
  });

  test("k: a local path that is not a repository's root blocks the job with a clear error", async () => {
    fake.setFakeBehaviour({});
    const outer = tempRepo();
    repos.push(outer);
    const inner = path.join(outer, "not-a-repo");
    fs.mkdirSync(inner);
    const [pr] = await db.q<{ id: number }>("insert into projects (slug, name, local_path, runner, test_command, delivery, gates) values ('kilo', 'kilo', $1, 'fake', 'npm test', 'local', $2) returning id", [inner, JSON.stringify({ plan: "manual", merge: "manual", deploy: "off", review: "off" })]);
    const item = await newItem(pr.id, "Wrong folder");
    const it = await until(item.id, (i) => i.status === "blocked", "blocked");
    await quiet(item.id);
    assert.match(it.error ?? "", /is not a git repository/);
    assert.equal(gitIn(outer, "worktree", "list").split("\n").length, 1, "nothing was done to the repository around it");
  });
});
