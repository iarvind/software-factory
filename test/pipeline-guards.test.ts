// The pipeline's guard rails and its ways out, end to end against the test database: the loop
// guard on a runner that repeats itself, the daily budget, branch clean-up when a job ends, and
// delivery "pr" to a remote that is not GitHub (a bare repository on disk).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitIn, skipIfNoDb, sleep, tempDir, tempRepo, useTestDb } from "./helpers.ts";
import type { Item } from "../server/lib/items.ts";
import type { AgentRunner, RunResult } from "../server/lib/runners/index.ts";

let DATA = "";
process.env.RUNNER = "fake";
process.env.NOTIFIER_URL = "";
process.env.MAX_CONCURRENT_RUNS = "2";

describe("pipeline guards and delivery (fake runner)", { skip: skipIfNoDb }, () => {
  let db: Awaited<ReturnType<typeof useTestDb>>;
  let pipeline: typeof import("../server/lib/pipeline.ts");
  let items: typeof import("../server/lib/items.ts");
  let fake: typeof import("../server/lib/runners/fake.ts");
  let settings: typeof import("../server/lib/settings.ts");
  const dirs: string[] = [];
  const touched = new Set<number>();
  const by = { via: "test", name: "tester" };
  /** How many tool calls each test runner made in its last run. */
  const calls: Record<string, number> = {};

  before(async () => {
    DATA = tempDir("factory-data-");
    process.env.FACTORY_DATA = DATA; // before git.ts is imported: clones and worktrees go here
    db = await useTestDb();
    const runners = await import("../server/lib/runners/index.ts");
    fake = await import("../server/lib/runners/fake.ts");
    settings = await import("../server/lib/settings.ts");
    runners.registerRunner(fake.fakeRunner);
    runners.registerRunner(looper(fake.fakeRunner));
    runners.registerRunner(stutter(fake.fakeRunner));
    pipeline = await import("../server/lib/pipeline.ts");
    items = await import("../server/lib/items.ts");
  });

  after(async () => {
    for (const id of touched) await quiet(id).catch(() => {});
    await settings?.saveSettings({ dailyBudgetUsd: 0 }).catch(() => {});
    await db?.close();
    for (const d of [...dirs, DATA].filter(Boolean)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Reads the same file over and over until it is stopped (and gives up by itself if nothing stops it). */
  function looper(base: AgentRunner): AgentRunner {
    return {
      ...base, id: "looper", label: "Looper (test)",
      async run(_spec, onEvent, signal): Promise<RunResult> {
        const started = Date.now();
        onEvent({ type: "init", sessionId: "loop-session", model: "loop" });
        calls.looper = 0;
        for (let i = 0; i < 100 && !signal.aborted; i++) {
          calls.looper++;
          onEvent({ type: "tool_use", name: "Read", input: { file_path: "README.md" }, id: `t${i}` });
          onEvent({ type: "tool_result", id: `t${i}`, output: "the same as last time" });
          await sleep(5);
        }
        if (signal.aborted) return { ok: false, sessionId: "loop-session", durationMs: Date.now() - started, exitCode: null, error: "cancelled", costUsd: 0.01, turns: calls.looper };
        return { ok: false, sessionId: "loop-session", durationMs: Date.now() - started, exitCode: 1, error: "nothing stopped the loop" };
      },
    };
  }

  /** Repeats itself three times, does something else, repeats three times again, then answers like the fake runner. */
  function stutter(base: AgentRunner): AgentRunner {
    return {
      ...base, id: "stutter", label: "Stutter (test)",
      async run(spec, onEvent, signal): Promise<RunResult> {
        const same = { name: "Read", input: { file_path: "README.md" } };
        const seq = [same, same, same, { name: "Grep", input: { pattern: "TODO" } }, same, same, same, { name: "Read", input: { file_path: "package.json" } }, same, same, same];
        calls.stutter = 0;
        for (const [i, c] of seq.entries()) {
          calls.stutter++;
          onEvent({ type: "tool_use", ...c, id: `s${i}` });
          onEvent({ type: "tool_result", id: `s${i}`, output: "ok" });
        }
        return base.run(spec, onEvent, signal);
      },
    };
  }

  async function project(slug: string, o: { failing?: boolean; runner?: string; gates?: Record<string, string>; limits?: Record<string, number> } = {}) {
    const repo = tempRepo({ failing: o.failing });
    dirs.push(repo);
    const [p] = await db.q<{ id: number }>(
      `insert into projects (slug, name, local_path, default_branch, runner, test_command, delivery, gates, limits, tools)
       values ($1, $1, $2, 'main', $3, 'npm test', 'local', $4, $5, $6) returning id`,
      [slug, repo, o.runner ?? "fake", JSON.stringify({ plan: "manual", merge: "manual", deploy: "off", review: "off", ...o.gates }), JSON.stringify(o.limits ?? {}), JSON.stringify({ mode: "edit", allow: [], deny: [] })],
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

  /** Until the item's timeline has an event whose message matches (the worktree clean-up logs one when it is through). */
  async function eventFor(id: number, re: RegExp, what: string): Promise<void> {
    const end = Date.now() + 15_000;
    for (;;) {
      const rows = await db.q<{ message: string | null }>("select message from events where item_id = $1 order by id", [id]);
      if (rows.some((r) => re.test(r.message ?? ""))) return;
      if (Date.now() > end) throw new Error(`#${id} never logged ${what}`);
      await sleep(100);
    }
  }

  /** Whether a branch exists in a repository (`--git-dir` for a bare one). */
  function hasBranch(gitArgs: string[], branch: string): boolean {
    try { execFileSync("git", [...gitArgs, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { stdio: "pipe" }); return true; } catch { return false; }
  }
  /** A project with delivery "pr" whose remote is a bare repository on disk (so: not GitHub), the merge gate manual. */
  async function offGithub(slug: string): Promise<{ id: number; bare: string }> {
    const origin = tempRepo();
    const bare = tempDir("factory-bare-");
    dirs.push(origin, bare);
    gitIn(origin, "clone", "--quiet", "--bare", origin, bare);
    const [p] = await db.q<{ id: number }>(
      `insert into projects (slug, name, repo_url, default_branch, runner, test_command, delivery, gates, tools)
       values ($1, $1, $2, 'main', 'fake', 'npm test', 'pr', $3, $4) returning id`,
      [slug, bare, JSON.stringify({ plan: "auto", merge: "manual", deploy: "off", review: "off" }), JSON.stringify({ mode: "edit", allow: [], deny: [] })],
    );
    return { id: p.id, bare };
  }
  const contains = (bare: string, sha: string, ref: string) => { try { execFileSync("git", ["--git-dir", bare, "merge-base", "--is-ancestor", sha, ref], { stdio: "pipe" }); return true; } catch { return false; } };
  const statuses = async (id: number) => (await db.q<{ s: string }>("select data->>'status' as s from events where item_id = $1 and type = 'status' order by id", [id])).map((r) => r.s);

  test("loop guard: the same tool call four times in a row stops the run, which fails, and the item is blocked", async () => {
    const p = await project("loopy", { runner: "looper" });
    const item = await newItem(p.id, "Read the readme forever");
    const it = await until(item.id, (i) => i.status === "blocked", "blocked");
    await quiet(item.id);

    assert.equal(calls.looper, 4, "the runner was stopped at the fourth identical call");
    const all = await items.runsFor(item.id);
    assert.deepEqual(all.map((r) => `${r.kind}:${r.status}`), ["plan:failed"], "a loop is a failure, not a cancellation");
    assert.match(all[0].error ?? "", /loop/);
    assert.match(it.error ?? "", /planning failed: loop/);
    const tools = await db.q<{ n: number }>("select count(*)::int as n from events where run_id = $1 and type = 'tool'", [all[0].id]);
    assert.equal(tools[0].n, 4);
    const errs = await db.q<{ message: string; run_id: number | null }>("select message, run_id from events where item_id = $1 and type = 'error' order by id", [item.id]);
    assert.match(errs[0]?.message ?? "", /^stopped: Read was called 4 times in a row with the same input/);
    assert.equal(errs[0].run_id, all[0].id, "the guard's note is on the run's timeline");
    assert.deepEqual(await statuses(item.id), ["inbox", "planning", "blocked"]);
    assert.equal(pipeline.isActive(item.id), false);
  });

  test("loop guard: repeats broken up by a different call are not a loop", async () => {
    const p = await project("stuttery", { runner: "stutter" });
    const item = await newItem(p.id, "Look around a bit");
    const it = await until(item.id, (i) => i.status === "awaiting_approval", "waiting for the plan approval");
    await quiet(item.id);
    assert.equal(calls.stutter, 11);
    assert.deepEqual((await items.runsFor(item.id)).map((r) => `${r.kind}:${r.status}`), ["plan:succeeded"]);
    assert.equal(it.plan?.summary, "Implement: Look around a bit");
    const errs = await db.q("select 1 from events where item_id = $1 and type = 'error'", [item.id]);
    assert.equal(errs.length, 0);
    await pipeline.cancel(item.id, by);
    await quiet(item.id);
  });

  test("daily budget: once today's runs cost more than the budget nothing new starts, and lifting it lets the item go on", async () => {
    fake.setFakeBehaviour({});
    const p = await project("budget");
    // Something that already ran today, for $1.00 (the database's day).
    const [earlier] = await db.q<{ id: number }>("insert into work_items (project_id, title, status, finished_at) values ($1, 'An earlier job', 'done', now()) returning id", [p.id]);
    await db.q("insert into runs (item_id, kind, runner, status, cost_usd, started_at, finished_at) values ($1, 'build', 'fake', 'succeeded', 1.0, now() - interval '5 minutes', now())", [earlier.id]);
    const item = await newItem(p.id, "Wait for the money");
    await settings.saveSettings({ dailyBudgetUsd: 0.01 });
    try {
      for (let i = 0; i < 3; i++) { await pipeline.tick(); await sleep(50); }
      const it = (await items.getItem(item.id))!;
      assert.equal(it.status, "inbox", "the item was not started");
      assert.equal(pipeline.isActive(item.id), false);
      assert.deepEqual(await items.runsFor(item.id), []);
      const holds = await db.q<{ message: string; level: string; item_id: number | null }>("select message, level, item_id from events where type = 'system' and message like 'holding new runs%' order by id");
      assert.equal(holds.length, 1, "said once, not on every tick");
      // Today's spend is the $1.00 above plus whatever the earlier tests in this file ran.
      const m = /^holding new runs: today's spend \(\$(\d+\.\d\d)\) has reached the daily budget \(\$0\.01\)/.exec(holds[0].message);
      assert.ok(m, holds[0].message);
      assert.ok(Number(m[1]) >= 1, `spend ${m[1]} counts the run recorded today`);
      assert.equal(holds[0].level, "warn");
      assert.equal(holds[0].item_id, null);
    } finally {
      await settings.saveSettings({ dailyBudgetUsd: 0 });
    }
    await until(item.id, (i) => i.status === "awaiting_approval", "planned once the budget is off");
    await quiet(item.id);
    assert.deepEqual((await items.runsFor(item.id)).map((r) => `${r.kind}:${r.status}`), ["plan:succeeded"]);
    await pipeline.cancel(item.id, by);
    await quiet(item.id);
  });

  test("branches: a merged job's branch is deleted with its worktree", async () => {
    fake.setFakeBehaviour({});
    const p = await project("merged", { gates: { plan: "auto", merge: "auto" } });
    const item = await newItem(p.id, "Tidy up after me");
    let it = await until(item.id, (i) => i.status === "done", "done");
    const branch = it.branch!;
    assert.equal(branch, `factory/${item.id}-tidy-up-after-me`);
    await eventFor(item.id, /^worktree removed, branch deleted/, "the worktree clean-up");
    await quiet(item.id);
    it = (await items.getItem(item.id))!;
    assert.equal(it.worktree, null);
    assert.match(gitIn(p.repo, "show", "main:FACTORY_NOTES.md"), /Tidy up after me/, "the work is on main");
    assert.equal(hasBranch(["-C", p.repo], branch), false, "the branch is gone");
    assert.equal(gitIn(p.repo, "branch", "--list", "factory/*"), "");
  });

  test("branches: a blocked job keeps its branch for a person to look at; cancelling it then deletes it", async () => {
    fake.setFakeBehaviour({});
    const p = await project("stuck", { failing: true, gates: { plan: "auto" }, limits: { maxFixRounds: 0 } });
    const item = await newItem(p.id, "Fail on purpose");
    let it = await until(item.id, (i) => i.status === "blocked", "blocked");
    await quiet(item.id);
    const branch = it.branch!;
    assert.match(branch, new RegExp(`^factory/${item.id}-`));
    assert.ok(it.worktree && fs.existsSync(it.worktree), "the worktree is kept for a retry");
    assert.equal(hasBranch(["-C", p.repo], branch), true, "the branch is kept");
    assert.equal(gitIn(p.repo, "rev-parse", `refs/heads/${branch}`), it.head_sha, "with the build's commit on it");

    it = await pipeline.cancel(item.id, by);
    await eventFor(item.id, /^worktree removed, branch deleted/, "the worktree clean-up");
    await quiet(item.id);
    assert.equal((await items.getItem(item.id))!.worktree, null);
    assert.equal(hasBranch(["-C", p.repo], branch), false, "an abandoned job's branch goes too");
  });

  test("delivery pr to a remote that is not GitHub: the branch is pushed, review and merge happen in the factory, main is pushed", async () => {
    fake.setFakeBehaviour({});
    const { id, bare } = await offGithub("offhub");
    const bareGit = ["--git-dir", bare];
    const item = await newItem(id, "Push it somewhere else");

    let it = await until(item.id, (i) => i.status === "review", "in review");
    await quiet(item.id);
    const branch = it.branch!;
    assert.ok(fs.existsSync(path.join(DATA, "repos", "offhub", ".git")), "the factory cloned the remote");
    assert.equal(hasBranch(bareGit, branch), true, "the branch is on the remote");
    assert.equal(gitIn(bare, "--git-dir", bare, "rev-parse", `refs/heads/${branch}`), it.head_sha, "at the build's commit");
    const pushed = await db.q<{ message: string; level: string }>("select message, level from events where item_id = $1 and type = 'git' and message like '%the remote is not GitHub%'", [item.id]);
    assert.equal(pushed.length, 1);
    assert.match(pushed[0].message, new RegExp(`^pushed ${branch}`));
    assert.equal(it.pr_url, null, "no pull request: there is nowhere to open one");
    assert.equal(it.pr_number, null);
    assert.equal(await items.pendingApproval(item.id), null, "review comes before the merge gate");
    assert.notEqual(gitIn(bare, "--git-dir", bare, "rev-parse", "main"), it.head_sha);

    await pipeline.reviewDecision(item.id, "approved", "fine by me", by);
    it = (await items.getItem(item.id))!;
    assert.equal(it.status, "awaiting_approval");
    assert.equal(it.gate, "merge");
    await pipeline.decide((await items.pendingApproval(item.id))!.id, "approved", by);
    it = await until(item.id, (i) => i.status === "done", "done");
    await eventFor(item.id, /^worktree removed/, "the worktree clean-up");
    await quiet(item.id);

    assert.ok(contains(bare, it.head_sha!, "main"), "the remote's main has the job's commit");
    assert.match(gitIn(bare, "--git-dir", bare, "log", "-1", "--format=%s", "main"), new RegExp(`^Merge #${item.id}: Push it somewhere else`));
    assert.match(gitIn(bare, "--git-dir", bare, "show", "main:FACTORY_NOTES.md"), /Push it somewhere else/);
    assert.deepEqual(await statuses(item.id), ["inbox", "planning", "queued", "building", "verifying", "review", "awaiting_approval", "merging", "done"]);
    assert.deepEqual((await items.approvalsFor(item.id)).map((a) => `${a.kind}:${a.status}`), ["merge:approved"]);
  });

  test("delivery pr to a remote that is not GitHub: if the remote's main moved on during review, the merge lands on top of it", async () => {
    fake.setFakeBehaviour({});
    const { id, bare } = await offGithub("offhub-moved");
    const item = await newItem(id, "Land after someone else");
    let it = await until(item.id, (i) => i.status === "review", "in review");
    await quiet(item.id);

    // Meanwhile a person pushes to the remote's main.
    const other = tempDir("factory-other-");
    dirs.push(other);
    gitIn(other, "clone", "--quiet", bare, ".");
    gitIn(other, "-c", "user.name=Someone", "-c", "user.email=someone@localhost", "commit", "--quiet", "--allow-empty", "-m", "someone else's change");
    gitIn(other, "push", "--quiet", "origin", "main");
    const theirs = gitIn(other, "rev-parse", "HEAD");

    await pipeline.reviewDecision(item.id, "approved", "fine", by);
    await pipeline.decide((await items.pendingApproval(item.id))!.id, "approved", by);
    it = await until(item.id, (i) => ["done", "blocked", "failed"].includes(i.status), "done or stopped");
    await quiet(item.id);
    assert.equal(it.status, "done", it.error ?? "");
    assert.ok(contains(bare, theirs, "main"), "the other change is still on the remote");
    assert.ok(contains(bare, it.head_sha!, "main"), "and the job's commit is on it too");
    assert.match(gitIn(bare, "--git-dir", bare, "log", "-1", "--format=%s", "main"), new RegExp(`^Merge #${item.id}: Land after someone else`));
  });

  test("delivery pr to a remote that is not GitHub: a push of main the remote refuses stops the job instead of calling it done", async () => {
    fake.setFakeBehaviour({});
    const { id, bare } = await offGithub("offhub-refused");
    const item = await newItem(id, "Be turned away");
    await until(item.id, (i) => i.status === "review", "in review");
    await quiet(item.id);
    // The branch is up already; from now on the remote turns away any update to main.
    const hook = path.join(bare, "hooks", "pre-receive");
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && { echo "main is protected" >&2; exit 1; }; done\nexit 0\n', { mode: 0o755 });
    const before = gitIn(bare, "--git-dir", bare, "rev-parse", "main");

    await pipeline.reviewDecision(item.id, "approved", "fine", by);
    await pipeline.decide((await items.pendingApproval(item.id))!.id, "approved", by);
    const it = await until(item.id, (i) => ["done", "blocked", "failed"].includes(i.status), "done or stopped");
    await quiet(item.id);
    assert.equal(it.status, "blocked");
    assert.match(it.error ?? "", /the push to origin\/main failed/);
    assert.match(it.error ?? "", /main is protected/, "with what the remote said");
    assert.equal(gitIn(bare, "--git-dir", bare, "rev-parse", "main"), before, "the remote's main is untouched");
  });
});
