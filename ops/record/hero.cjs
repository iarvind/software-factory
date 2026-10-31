#!/usr/bin/env node
// Records the README's hero (request → done on the Demo service, with the real agent) and, while
// that request waits at its plan gate, the Board with a few fake-runner requests moving on
// "Demo (remote)" (board.cjs). Sets the Demo service's plan gate to manual for the take and puts it back.
//   node ops/record/hero.cjs            then: node ops/record/encode.cjs data/media/frames/hero <edit.json>
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lib.cjs");
const { boardLive } = require("./board.cjs");

const DEMO = Number(process.env.DEMO_PROJECT || 2), REMOTE = Number(process.env.REMOTE_PROJECT || 3);
const DEMO_LABEL = process.env.DEMO_LABEL || "Demo service"; // DEMO_PROJECT=3 DEMO_LABEL="Demo (remote)" rehearses on the fake runner
const TITLE = "Add a GET /stats endpoint";
const BODY = "Return the number of requests served since the server started, as JSON. Add a test and a line in the README.";
const TAKE = process.env.TAKE || "";
const frames = (n) => path.join(L.MEDIA, "frames", TAKE + n);
const CLOSED = ["done", "failed", "cancelled", "blocked"];

(async () => {
  const browser = await L.launch();
  const admin = await L.context(browser);
  const a = L.api(admin);
  const before = (await a.get(`/api/projects/${DEMO}`));
  const gates = (before.project ?? before).gates;
  console.log("gates before:", JSON.stringify(gates));
  await a.patch(`/api/projects/${DEMO}`, { gates: { plan: "manual", merge: "auto", review: "ai" } });
  const out = { started: new Date().toISOString() };
  try {
    const ctx = await L.context(browser, { signIn: false });
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.accept());
    console.log("hero:");
    await page.goto(L.BASE + "/", { waitUntil: "networkidle" });
    const rec = await L.record(page, frames("hero"));
    const ptr = L.pointer(page);
    await page.mouse.move(900, 620);
    await L.sleep(1800);
    rec.mark("login");
    await L.login(ctx);
    await page.goto(L.BASE + "/", { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Board" }).waitFor();
    await page.mouse.move(900, 620);
    rec.mark("board");
    await L.sleep(1400);
    await ptr.click(page.getByRole("button", { name: "New request" }));
    const form = page.locator("form").filter({ hasText: "What do you need?" });
    await form.waitFor();
    rec.mark("form");
    await L.sleep(500);
    await ptr.click(form.getByLabel("What do you need?"), 450);
    await form.getByLabel("What do you need?").pressSequentially(TITLE, { delay: 55 });
    await L.sleep(300);
    await ptr.click(form.getByLabel("Details"), 450);
    await form.getByLabel("Details").pressSequentially(BODY, { delay: 22 });
    await L.sleep(300);
    await ptr.to(form.getByLabel("Project"), 500);
    await form.getByLabel("Project").selectOption({ label: DEMO_LABEL });
    await L.sleep(700);
    rec.mark("send");
    await ptr.click(form.getByRole("button", { name: "Send request" }));
    await page.waitForURL(/\/items\/\d+/);
    const id = Number(/\/items\/(\d+)/.exec(page.url())[1]);
    out.hero = id;
    rec.mark("sent");
    console.log(`  item #${id}`);
    await page.getByRole("heading", { name: TITLE }).waitFor();
    await L.sleep(1200);
    const follow = page.getByRole("button", { name: /^Follow(ing)? live$/ });
    if (await follow.isVisible().catch(() => false)) { await ptr.click(follow, 700); rec.mark("follow1"); }
    await ptr.park(1235, 470, 600);

    const seen = new Set();
    const waitFor = async (want, limitS) => {
      for (let i = 0; i < limitS * 2; i++) {
        const it = (await a.get(`/api/items/${id}`)).item;
        if (!seen.has(it.status)) { seen.add(it.status); rec.mark(`s-${it.status}`); }
        if (want.includes(it.status)) return it;
        if (CLOSED.includes(it.status) || it.status === "needs_info") throw new Error(`#${id} ended up ${it.status}: ${it.error ?? ""}`);
        await L.sleep(500);
      }
      throw new Error(`#${id} did not reach ${want} in ${limitS}s`);
    };
    await waitFor(["awaiting_approval"], 300);
    rec.mark("planned");
    await L.sleep(1500);

    rec.mark("idle-from");
    out.board = await boardLive(browser, { dir: frames("board-live") });
    await page.bringToFront();
    rec.mark("idle-to");

    await L.scrollTo(page, 0, 900);
    await L.sleep(2600);
    rec.mark("plan-card");
    await L.scrollToEl(page, page.locator(".plan").first(), 64, 1100);
    await L.sleep(3800);
    const approve = page.getByRole("button", { name: "Approve plan" });
    await L.scrollToEl(page, page.locator(".ask").first(), 90, 900);
    await L.sleep(600);
    rec.mark("approve");
    await ptr.click(approve, 800);
    rec.mark("approved");
    await waitFor(["building", "verifying", "reviewing", "merging", "done"], 120);
    await L.sleep(800);
    await L.scrollToEl(page, page.locator(".tl-tools"), 60, 900);
    const follow2 = page.getByRole("button", { name: /^Follow live$/ });
    if (await follow2.isVisible().catch(() => false)) { await ptr.click(follow2, 700); rec.mark("follow2"); }
    await ptr.park(1235, 470, 600);
    await waitFor(["done"], 900);
    rec.mark("done");
    for (let i = 0; i < 40; i++) {
      const evs = await a.get(`/api/items/${id}/events?after=0&limit=2000`);
      if (evs.some((e) => e.type === "note" && /^for the book/.test(e.message ?? ""))) break;
      await L.sleep(500);
    }
    await L.sleep(1500);
    await L.scrollTo(page, 1e6, 900);
    rec.mark("learned");
    await L.sleep(4500);
    await L.scrollTo(page, 0, 1100);
    rec.mark("top");
    await L.sleep(3000);
    await rec.stop();
    await ctx.close();
  } catch (e) {
    console.error("FAILED:", e.message);
    out.error = e.message;
  } finally {
    await a.patch(`/api/projects/${DEMO}`, { gates: { plan: gates.plan, merge: gates.merge, review: gates.review } }).catch((e) => console.error("could not restore gates:", e.message));
    const after = await a.get(`/api/projects/${DEMO}`);
    console.log("gates after:", JSON.stringify((after.project ?? after).gates));
    fs.writeFileSync(path.join(L.MEDIA, `${TAKE}hero.json`), JSON.stringify(out, null, 1));
    await browser.close();
  }
})();
