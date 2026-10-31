import { test } from "node:test";
import assert from "node:assert/strict";
import { dueSince, matches, next, parseCron } from "../server/lib/cron.ts";

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
// Local times, as the cron module uses. 2026-01-05 is a Monday.
const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 0, d, h, m, s);

test("parse: plain values, ranges, lists, steps", () => {
  const c = parseCron("30 2 * * 1-5");
  assert.deepEqual(sorted(c.minute), [30]);
  assert.deepEqual(sorted(c.hour), [2]);
  assert.equal(c.dom.size, 31);
  assert.equal(c.month.size, 12);
  assert.deepEqual(sorted(c.dow), [1, 2, 3, 4, 5]);
  assert.equal(c.raw, "30 2 * * 1-5");
  assert.deepEqual(sorted(parseCron("*/15 * * * *").minute), [0, 15, 30, 45]);
  assert.deepEqual(sorted(parseCron("5-20/5 * * * *").minute), [5, 10, 15, 20]);
  assert.deepEqual(sorted(parseCron("10/20 * * * *").minute), [10, 30, 50], "a start with a step runs to the end of the range");
  assert.deepEqual(sorted(parseCron("0 8,12,18 * * *").hour), [8, 12, 18]);
  assert.deepEqual(sorted(parseCron("0 0 1,15 * *").dom), [1, 15]);
});

test("parse: month and day names, Sunday as 7", () => {
  const c = parseCron("0 9 * jan,jul mon-fri");
  assert.deepEqual(sorted(c.month), [1, 7]);
  assert.deepEqual(sorted(c.dow), [1, 2, 3, 4, 5]);
  assert.deepEqual(sorted(parseCron("0 9 * * SAT,SUN").dow), [0, 6]);
  assert.ok(parseCron("0 9 * * 7").dow.has(0), "7 means Sunday too");
  assert.deepEqual(sorted(parseCron("0 0 * mar-may/2 *").month), [3, 5]);
});

test("parse: rejects what is not cron", () => {
  for (const bad of ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "abc * * * *", "5-1 * * * *", "* * * foo *", ""]) {
    assert.throws(() => parseCron(bad), Error, `"${bad}" should not parse`);
  }
});

test("matches: every field must agree", () => {
  const c = parseCron("30 2 * * 1-5");
  assert.equal(matches(c, at(5, 2, 30)), true); // Monday
  assert.equal(matches(c, at(5, 2, 31)), false);
  assert.equal(matches(c, at(5, 3, 30)), false);
  assert.equal(matches(c, at(4, 2, 30)), false); // Sunday
  assert.equal(matches(parseCron("* * * * *"), at(17, 13, 7)), true);
  assert.equal(matches(parseCron("0 12 1 jan *"), new Date(2026, 0, 1, 12, 0)), true);
});

test("next: the following firing, across days and weekends", () => {
  const c = parseCron("30 2 * * 1-5");
  assert.deepEqual(next(c, at(5, 2, 30)), at(6, 2, 30), "strictly after `from`");
  assert.deepEqual(next(c, at(5, 2, 29, 59)), at(5, 2, 30));
  assert.deepEqual(next(c, at(9, 2, 31)), at(12, 2, 30), "Friday after the firing → Monday");
  assert.deepEqual(next(parseCron("*/15 * * * *"), at(5, 10, 7, 42)), at(5, 10, 15));
  assert.deepEqual(next(parseCron("0 0 1 * *"), at(20, 9, 0)), new Date(2026, 1, 1, 0, 0));
  assert.equal(next(parseCron("0 0 31 2 *"), at(5, 0, 0)), null, "February 31st never comes");
});

test("dueSince: fired in (last, now]", () => {
  const c = parseCron("30 2 * * *");
  assert.equal(dueSince(c, at(5, 2, 29), at(5, 2, 31)), true);
  assert.equal(dueSince(c, at(5, 2, 29), at(5, 2, 30)), true, "now is inclusive");
  assert.equal(dueSince(c, at(5, 2, 30), at(5, 2, 45)), false, "last is exclusive");
  assert.equal(dueSince(c, at(5, 2, 31), at(6, 2, 29)), false);
  assert.equal(dueSince(c, at(5, 2, 31), at(7, 9, 0)), true, "a missed firing is still due");
  assert.equal(dueSince(c, null, at(5, 2, 30, 20)), true, "never run: the minute before now counts");
  assert.equal(dueSince(c, null, at(5, 2, 32)), false);
  const steps = parseCron("*/10 9-17 * * mon-fri");
  assert.equal(dueSince(steps, at(10, 9, 55), at(10, 10, 5)), false, "Saturday");
  assert.equal(dueSince(steps, at(12, 9, 55), at(12, 10, 5)), true, "Monday 10:00");
  assert.equal(dueSince(steps, at(12, 17, 51), at(12, 18, 30)), false, "after hours");
});
