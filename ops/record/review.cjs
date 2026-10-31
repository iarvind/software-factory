#!/usr/bin/env node
// Records an item's Changes tab (the diff), its Runs tab with one prompt opened, and its
// Messages tab. The item needs a worktree for the diff, so record it while the change waits
// at the merge gate or in review.   node ops/record/review.cjs <item id>
const path = require("node:path");
const L = require("./lib.cjs");

/** Smoothly scrolls the first scrollable element inside loc (a sheet's body) by dy. */
async function scrollWithin(loc, dy, ms = 800) {
  await loc.evaluate((root, [by, dur]) => new Promise((done) => {
    const all = [root, ...root.querySelectorAll("*")];
    const el = all.find((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) || root;
    const from = el.scrollTop, t0 = performance.now();
    const step = (now) => { const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; el.scrollTop = from + by * e; if (k < 1) requestAnimationFrame(step); else done(); };
    requestAnimationFrame(step);
  }), [dy, ms]);
}

async function recordReview(id, { browser: given } = {}) {
  const browser = given ?? (await L.launch());
  const ctx = await L.context(browser);
  const page = await ctx.newPage();
  console.log(`review-diff (#${id}):`);
  await page.goto(`${L.BASE}/items/${id}`, { waitUntil: "networkidle" });
  const rec = await L.record(page, path.join(L.MEDIA, "frames", "review-diff"));
  const ptr = L.pointer(page);
  await page.mouse.move(1180, 300);
  await L.sleep(2200);
  rec.mark("top");
  // Scrolls are marked (scN … scN-end) so the edit can play them faster than the pauses.
  let sc = 0;
  const scroll = async (fn) => { const n = ++sc; rec.mark(`sc${n}`); await fn(); rec.mark(`sc${n}-end`); };
  const tabs = page.getByRole("tablist", { name: "Item views" });
  await scroll(() => L.scrollToEl(page, tabs, 24, 900));
  await L.sleep(400);
  await ptr.click(tabs.getByRole("tab", { name: /^Changes/ }));
  await page.locator(".diff, .diff-file, table").first().waitFor({ timeout: 10000 }).catch(() => {});
  await L.sleep(400);
  rec.mark("changes");
  await ptr.park(1180, 420, 500);
  await L.sleep(2200);
  for (let i = 0; i < 3; i++) { await scroll(() => L.scrollBy(page, 470, 800)); await L.sleep(1800); }
  rec.mark("diff-read");
  await scroll(() => L.scrollToEl(page, tabs, 24, 900));
  await L.sleep(300);
  await ptr.click(tabs.getByRole("tab", { name: /^Runs/ }));
  rec.mark("runs");
  await L.sleep(1800);
  const build = page.locator("tr").filter({ hasText: /^build/ }).first();
  const row = (await build.count()) ? build : page.locator("tbody tr").nth(1);
  await ptr.click(row.getByRole("button", { name: "View prompt" }), 800);
  await page.locator(".run-block pre").first().waitFor({ timeout: 10000 });
  rec.mark("prompt");
  await L.sleep(2600);
  await ptr.park(640, 520, 500);
  await scroll(() => scrollWithin(page.getByRole("dialog"), 560, 1000));
  await L.sleep(2400);
  await page.keyboard.press("Escape");
  await L.sleep(600);
  await ptr.click(tabs.getByRole("tab", { name: /^Messages/ }));
  rec.mark("messages");
  await ptr.park(1180, 420, 500);
  await L.sleep(3200);
  await rec.stop();
  await ctx.close();
  if (!given) await browser.close();
}

module.exports = { recordReview };
if (require.main === module) {
  const id = Number(process.argv[2]);
  if (!id) { console.error("usage: node ops/record/review.cjs <item id>"); process.exit(2); }
  recordReview(id).catch((e) => { console.error(e); process.exit(1); });
}
