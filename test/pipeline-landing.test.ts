// Landing work when the repository is busy, end to end against the test database with the fake
// runner and a real git repository per scenario (delivery "local"): several jobs of one project
// at once (worktrees, commits and merges into the same repository), and the reconcile round when
// the default branch moved while a job waited for its merge.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitIn, skipIfNoDb, sleep, tempDir, tempRepo, useTestDb } from "./helpers.ts";
import type { Item } from "../server/lib/items.ts";

let DATA = "";
process.env.RUNNER = "fake";
process.env.NOTIFIER_URL = "";
process.env.MAX_CONCURRENT_RUNS = "2";

describe("landing work on a busy repository (fake runner)", { skip: skipIfNoDb }, () => {
  let db: Awaited<ReturnType<typeof useTestDb>>;
  let pipeline: typeof import("../server/lib/pipeline.ts");
  let items: typeof import("../server/lib/items.ts");
  let fake: typeof import("../server/lib/runners/fake.ts");
  let settings: typeof import("../server/lib/settings.ts");
  const repos: string[] = [];
  const touched = new Set<number>();
  const by = { via: "test", name: "tester" };
  const stopped = ["done", "blocked", "failed", "cancelled"];

  before(async () => {
    DATA = tempDir("factory-data-");
    process.env.FACTORY_DATA = DATA; // before git.ts is imported: worktrees go here
    db = await useTestDb();
    const runners = await import("../server/lib/runners/index.ts");
    fake = await import("../server/lib/runners/fake.ts");
    settings = await import("../server/lib/settings.ts");
    runners.registerRunner(fake.fakeRunner);
    pipeline = await import("../server/lib/pipeline.ts");
    items = await import("../server/lib/items.ts");
  });

  after(async () => {
    for (const id of touched) await quiet(id).catch(() => {});
    await db?.close();
    for (const d of [...repos, DATA].filter(Boolean)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function project(slug: string, o: { gates?: Record<string, string>; limits?: Record<string, number> } = {}) {
    const repo = tempRepo();
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
  async function until(id: number, pred: (it: Item) => boolean, what: string): Promise<Item> {
    const end = Date.now() + 30_000;
    for (;;) {
      await pipeline.tick();
      const it = (await items.getItem(id))!;
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

  /** Commits a file straight onto the repository's main, as a person would while a job waits. */
  function commitOnMain(repo: string, file: string, content: string, message: string): string {
    fs.writeFileSync(path.join(repo, file), content);
    gitIn(repo, "add", file);
    gitIn(repo, "commit", "-q", "-m", message);
    return gitIn(repo, "rev-parse", "HEAD");
  }

  const isAncestor = (repo: string, sha: string, ref: string) => { try { execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", sha, ref], { stdio: "pipe" }); return true; } catch { return false; } };
  const gitEvents = async (id: number) => (await db.q<{ message: string; level: string }>("select message, level from events where item_id = $1 and type = 'git' order by id", [id]));
  const statuses = async (id: number) => (await db.q<{ s: string }>("select data->>'status' as s from events where item_id = $1 and type = 'status' order by id", [id])).map((r) => r.s);
  const runs = async (id: number) => (await items.runsFor(id)).map((r) => `${r.kind}:${r.status}`);
  const LOCK_TROUBLE = /could not lock|index\.lock/i;

  test("concurrency: four jobs on a project that runs two at a time all land, and git's locks never get in the way", async () => {
    fake.setFakeBehaviour({});
    await settings.saveSettings({ maxConcurrentRuns: 2 });
    const p = await project("busy", { gates: { plan: "auto", merge: "auto" }, limits: { concurrency: 2 } });
    const four = await Promise.all(["Job one", "Job two", "Job three", "Job four"].map((t) => newItem(p.id, t)));
    const ids = four.map((i) => i.id);

    let most = 0;
    const end = Date.now() + 100_000;
    let now: Item[] = [];
    for (;;) {
      await pipeline.tick();
      most = Math.max(most, pipeline.activeRuns().filter((r) => r.projectId === p.id).length);
      now = await Promise.all(ids.map(async (id) => (await items.getItem(id))!));
      if (now.every((i) => stopped.includes(i.status))) break;
      if (Date.now() > end) throw new Error(`timed out: ${now.map((i) => `#${i.id} ${i.status}${i.error ? ` (${i.error})` : ""}`).join("; ")}`);
      await sleep(100);
    }
    for (const id of ids) await quiet(id);

    for (const it of now) assert.doesNotMatch(it.error ?? "", LOCK_TROUBLE, `#${it.id} ran into a git lock`);
    const lockEvents = await db.q<{ item_id: number; message: string }>("select item_id, message from events where item_id = any($1) and (message ~* 'could not lock' or message ~* 'index\\.lock')", [ids]);
    assert.deepEqual(lockEvents, [], "no event mentions a git lock");
    assert.equal(most, 2, "two jobs of the project ran at once (and never more)");
    assert.deepEqual(now.map((i) => `#${i.id} ${i.status}${i.error ? ` (${i.error})` : ""}`), ids.map((id) => `#${id} done`), "every job landed");

    // Every job's work is on main, and the checkout was left clean.
    const notes = gitIn(p.repo, "show", "main:FACTORY_NOTES.md");
    for (const it of four) assert.match(notes, new RegExp(`${it.title} \\(fake runner\\)`));
    assert.doesNotMatch(notes, /^(<{7}|={7}|>{7})/m, "no conflict markers");
    assert.equal(gitIn(p.repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(gitIn(p.repo, "status", "--porcelain"), "");
    assert.equal(gitIn(p.repo, "worktree", "list").split("\n").length, 1, "every job's worktree is gone");
  });

  test("reconcile: main moved under the job and conflicts with it; the agent keeps both sides, it is verified again and lands", async () => {
    fake.setFakeBehaviour({});
    const p = await project("conflicted", { gates: { plan: "auto", merge: "manual" } });
    const item = await newItem(p.id, "Note the change");
    let it = await until(item.id, (i) => i.status === "review", "in review");
    await quiet(item.id);
    const built = it.head_sha!;
    // Meanwhile a person writes the same file on main: both sides add FACTORY_NOTES.md, so they conflict.
    const theirs = commitOnMain(p.repo, "FACTORY_NOTES.md", "- someone else's note, straight on main\n", "someone else's note");

    await pipeline.reviewDecision(item.id, "approved", "fine", by);
    await pipeline.decide((await items.pendingApproval(item.id))!.id, "approved", by);
    it = await until(item.id, (i) => stopped.includes(i.status), "done or stopped");
    await quiet(item.id);

    assert.equal(it.status, "done", it.error ?? "");
    assert.equal(it.fix_rounds, 1, "one reconcile round");
    const ev = (await gitEvents(item.id)).map((e) => e.message);
    const conflicted = ev.findIndex((m) => /conflicts in FACTORY_NOTES\.md/.test(m));
    const merged = ev.findIndex((m) => /^merged into main at [0-9a-f]{7}/.test(m));
    assert.ok(conflicted >= 0, `a git event names the conflicted file: ${JSON.stringify(ev)}`);
    assert.ok(merged > conflicted, `and the merge into main comes after it: ${JSON.stringify(ev)}`);
    assert.ok(ev.some((m) => /main moved while the job waited/.test(m)), "the merge step said main moved before it reconciled");
    assert.deepEqual(await runs(item.id), ["plan:succeeded", "build:succeeded", "fix:succeeded", "learn:succeeded"]);
    // The order that matters: it went to merge, stopped to fix the conflict, merged again, and finished.
    const seq = await statuses(item.id);
    const after = (from: number, st: string) => seq.indexOf(st, from);
    const m1 = after(seq.indexOf("awaiting_approval"), "merging"), fx = after(m1 + 1, "fixing"), m2 = after(fx + 1, "merging"), dn = after(m2 + 1, "done");
    assert.ok(m1 > 0 && fx > m1 && m2 > fx && dn > m2, `merging → fixing → merging → done, in that order: ${JSON.stringify(seq)}`);
    const verified = await db.q<{ level: string }>("select level from events where item_id = $1 and type = 'verify' order by id", [item.id]);
    assert.deepEqual(verified.map((v) => v.level), ["info", "info"], "verified after the build and again after the reconcile");

    assert.ok(isAncestor(p.repo, theirs, "main"), "the other change is still on main");
    assert.ok(isAncestor(p.repo, built, "main"), "and the job's commit is on it too");
    const notes = gitIn(p.repo, "show", "main:FACTORY_NOTES.md");
    assert.doesNotMatch(notes, /^(<{7}|={7}|>{7})/m, "no conflict markers on main");
    assert.match(notes, /someone else's note, straight on main/);
    assert.match(notes, /Note the change \(fake runner\)/);
    assert.match(gitIn(p.repo, "log", "-1", "--format=%s", "main"), new RegExp(`^Merge #${item.id}: Note the change`));
    assert.equal(gitIn(p.repo, "status", "--porcelain"), "", "the live checkout is clean");
  });

  test("reconcile: main moved in another file; nothing to resolve, no fix run, and it lands", async (t) => {
    fake.setFakeBehaviour({});
    const p = await project("moved", { gates: { plan: "auto", merge: "manual" } });
    const item = await newItem(p.id, "Land beside a change");
    let it = await until(item.id, (i) => i.status === "review", "in review");
    await quiet(item.id);
    const built = it.head_sha!;
    const theirs = commitOnMain(p.repo, "OTHER.md", "something else\n", "an unrelated change");

    await pipeline.reviewDecision(item.id, "approved", "fine", by);
    await pipeline.decide((await items.pendingApproval(item.id))!.id, "approved", by);
    it = await until(item.id, (i) => stopped.includes(i.status), "done or stopped");
    await quiet(item.id);

    assert.equal(it.status, "done", it.error ?? "");
    assert.ok(!(await runs(item.id)).some((r) => r.startsWith("fix:")), "no fix run");
    assert.ok(isAncestor(p.repo, theirs, "main") && isAncestor(p.repo, built, "main"), "both changes are on main");
    assert.equal(gitIn(p.repo, "show", "main:OTHER.md"), "something else");
    const ev = (await gitEvents(item.id)).map((e) => e.message);
    assert.ok(ev.some((m) => /^merged into main at [0-9a-f]{7}/.test(m)));
    await t.test("main is merged into the branch (and verified) before it lands", async () => {
      assert.ok(ev.some((m) => /merged into the branch cleanly/.test(m)), `a git event says main was merged into the branch cleanly: ${JSON.stringify(ev)}`);
    });
  });

  test("reconcile: with no fix rounds allowed, a conflict parks the job for a person and leaves main alone", async () => {
    fake.setFakeBehaviour({});
    const p = await project("no-rounds", { gates: { plan: "auto", merge: "manual" }, limits: { maxFixRounds: 0 } });
    const item = await newItem(p.id, "Collide and stop");
    let it = await until(item.id, (i) => i.status === "review", "in review");
    await quiet(item.id);
    const theirs = commitOnMain(p.repo, "FACTORY_NOTES.md", "- someone else's note, straight on main\n", "someone else's note");

    await pipeline.reviewDecision(item.id, "approved", "fine", by);
    await pipeline.decide((await items.pendingApproval(item.id))!.id, "approved", by);
    it = await until(item.id, (i) => stopped.includes(i.status), "done or stopped");
    await quiet(item.id);

    assert.equal(it.status, "blocked");
    assert.match(it.error ?? "", /reconcile it by hand|conflicting/);
    assert.ok(!(await runs(item.id)).some((r) => r.startsWith("fix:")), "no agent was asked to resolve it");
    assert.equal(gitIn(p.repo, "rev-parse", "main"), theirs, "main is untouched");
    assert.equal(gitIn(p.repo, "status", "--porcelain"), "", "the live checkout is not left mid-merge");
    assert.equal(fs.readFileSync(path.join(p.repo, "FACTORY_NOTES.md"), "utf8"), "- someone else's note, straight on main\n");
    assert.ok(it.worktree && fs.existsSync(it.worktree), "the worktree is kept for a person to look at");
  });
});
