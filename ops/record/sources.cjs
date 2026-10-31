#!/usr/bin/env node
// Records Sources → Add source → the kinds → Slack's setup help with the app manifest.
// Opens the sheets only; saves nothing.   node ops/record/sources.cjs
const path = require("node:path");
const L = require("./lib.cjs");
const { encode } = require("./encode.cjs");

async function wheel(page, dy, ms = 700) {
  const steps = Math.max(6, Math.round(ms / 25));
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy / steps); await L.sleep(ms / steps); }
}

(async () => {
  const browser = await L.launch();
  const ctx = await L.context(browser);
  const page = await ctx.newPage();
  await page.goto(`${L.BASE}/sources`, { waitUntil: "networkidle" });
  const dir = path.join(L.MEDIA, "frames", "sources");
  const rec = await L.record(page, dir);
  const ptr = L.pointer(page);
  await page.mouse.move(900, 600);
  await L.sleep(1600);
  await ptr.click(page.getByRole("button", { name: "Add source" }).first());
  const sheet = page.getByRole("dialog");
  await sheet.locator(".kind").first().waitFor();
  rec.mark("kinds");
  await L.sleep(900);
  const kinds = sheet.locator(".kind");
  const n = await kinds.count();
  for (let i = 1; i < n; i++) { await ptr.to(kinds.nth(i), 260); await L.sleep(320); }
  await L.sleep(500);
  rec.mark("slack");
  await ptr.click(kinds.filter({ hasText: "Slack" }).first(), 700);
  await sheet.locator(".setup-help").waitFor();
  await L.sleep(2200);
  await ptr.park(640, 500, 500);
  await wheel(page, 380, 1000);
  await L.sleep(2400);
  await wheel(page, 420, 1000);
  await L.sleep(2600);
  rec.mark("manifest");
  await page.keyboard.press("Escape");
  await L.sleep(800);
  await rec.stop();
  await browser.close();
  encode(dir, { name: "sources", fps: 12, colors: 96, segments: [{ from: "start", to: "end", speed: 1 }] });
})();
