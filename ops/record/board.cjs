#!/usr/bin/env node
// Records the Board while a few fake-runner requests go through "Demo (remote)": they arrive,
// plan, queue, build and land, and whatever waits on a person sits in "Needs you" on top.
// hero.cjs calls this while its request waits at the plan gate; on its own it is best run while
// something waits on a person.   node ops/record/board.cjs
const path = require("node:path");
const L = require("./lib.cjs");

const REMOTE = Number(process.env.REMOTE_PROJECT || 3);
const CLOSED = ["done", "failed", "cancelled", "blocked"];
const TITLES = [
  ["Log the port on startup", "Print one line with the port when the server starts."],
  ["Document the /slug endpoint", "Add an example of /slug?text= to the README."],
  ["Add a CONTRIBUTING note", "Two lines: run npm test before you push; one change per pull request."],
  ["Changelog entry for 1.1", "Add a 1.1 section to CHANGELOG.md listing /time and /version."],
];

async function boardLive(browser, { titles = TITLES, dir = path.join(L.MEDIA, "frames", "board-live") } = {}) {
  console.log("board-live:");
  const ctx = await L.context(browser);
  const page = await ctx.newPage();
  const a = L.api(ctx);
  await page.goto(L.BASE + "/", { waitUntil: "networkidle" });
  const rec = await L.record(page, dir);
  const ptr = L.pointer(page);
  await page.mouse.move(1180, 760);
  await L.sleep(1800);
  rec.mark("ready");
  const ids = [];
  for (const [title, body] of titles) {
    ids.push((await a.post("/api/items", { title, body, projectId: REMOTE, priority: 3 })).id);
    await L.sleep(2600);
  }
  rec.mark("filed");
  for (let i = 0; i < 60; i++) {
    const st = await Promise.all(ids.map(async (id) => (await a.get(`/api/items/${id}`)).item.status));
    if (st.every((s) => CLOSED.includes(s))) break;
    await L.sleep(1000);
  }
  rec.mark("settled");
  await L.sleep(1200);
  const needs = page.locator("section.needs");
  if (await needs.count()) { await ptr.to(needs.locator("a").first(), 900); await L.sleep(1800); }
  rec.mark("hovered");
  await L.sleep(800);
  await rec.stop();
  await ctx.close();
  return ids;
}

module.exports = { boardLive, TITLES };
if (require.main === module) {
  const fresh = [
    ["Add an .editorconfig", "Two-space indent, LF line endings, a final newline."],
    ["Add a CODEOWNERS file", "One line that makes the maintainers own everything."],
    ["Mention the 404 body in the README", "Say that unknown paths answer 404 with a JSON error."],
    ["Link the factory docs from the README", "One line under the heading pointing at the factory's docs."],
  ];

  (async () => {
    const browser = await L.launch();
    try { await boardLive(browser, { titles: fresh }); } finally { await browser.close(); }
  })().catch((e) => { console.error(e); process.exit(1); });
}
