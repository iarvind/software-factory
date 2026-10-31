// withRepoLock, on its own: work on one repository takes turns (git's index, config and ref locks
// trip when two jobs touch the same repository at once), work on another repository does not wait,
// and a failure does not wedge the queue. No database, no git: the lock is keyed by the path.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "./helpers.ts";

describe("withRepoLock", () => {
  let git: typeof import("../server/lib/git.ts");
  before(async () => {
    git = await import("../server/lib/git.ts");
  });

  /** A task that records when it started and finished. */
  function timed(spans: Record<string, { start: number; end: number }>, name: string, ms: number) {
    return async () => {
      spans[name] = { start: performance.now(), end: Number.NaN };
      await sleep(ms);
      spans[name].end = performance.now();
      return name;
    };
  }

  test("two overlapping tasks on the same repository run one after the other; another repository's runs alongside", async () => {
    const spans: Record<string, { start: number; end: number }> = {};
    const results = await Promise.all([
      git.withRepoLock("/tmp/lock-test/a", timed(spans, "a1", 200)),
      git.withRepoLock("/tmp/lock-test/a", timed(spans, "a2", 50)),
      git.withRepoLock("/tmp/lock-test/b", timed(spans, "b1", 100)),
    ]);
    assert.deepEqual(results, ["a1", "a2", "b1"], "each caller gets its own task's result");
    assert.ok(spans.a2.start >= spans.a1.end, `a2 started at ${spans.a2.start.toFixed(1)}, before a1 finished at ${spans.a1.end.toFixed(1)}`);
    assert.ok(spans.b1.start < spans.a1.end, "the other repository did not wait for a1");
    assert.ok(spans.b1.end < spans.a1.end, "and finished while a1 was still running");
  });

  test("a task that fails gets its own error, and the next one on that repository still runs", async () => {
    const spans: Record<string, { start: number; end: number }> = {};
    let failedAt = Number.NaN;
    const first = git.withRepoLock("/tmp/lock-test/c", async () => { await sleep(80); failedAt = performance.now(); throw new Error("git said no"); });
    const second = git.withRepoLock("/tmp/lock-test/c", timed(spans, "c2", 10));
    await assert.rejects(first, /git said no/);
    assert.equal(await second, "c2");
    assert.ok(spans.c2.start >= failedAt, "it waited for the failing task to finish");
    assert.equal(await git.withRepoLock("/tmp/lock-test/c", async () => "after"), "after", "the queue is not wedged");
  });
});
