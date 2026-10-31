#!/usr/bin/env node
// Clicks through the main flows against a running server with the dev login: sign in, file a
// request, watch it land, open every tab and page, open the add sheets, save settings, make a
// token. Reports page and console errors. node ops/clickthrough.cjs (BASE, EMAIL as in shoot.cjs)
const fs = require("node:fs");
const path = require("node:path");
const core = process.env.PLAYWRIGHT_CORE || path.join(process.env.HOME, "Self/musicgen-ai/node_modules/playwright-core");
const { chromium } = require(core);
const base = process.env.BASE || "http://127.0.0.1:8282";
const envFile = path.join(__dirname, "..", ".env");
const email = process.env.EMAIL || (fs.existsSync(envFile) ? /^ADMIN_EMAILS=([^\s,]+)/m.exec(fs.readFileSync(envFile, "utf8"))?.[1] : "") || "demo@factory.test";
const out = path.join(__dirname, "..", "data", "shots");
fs.mkdirSync(out, { recursive: true });
const problems = [];
const steps = [];
const step = (s) => { steps.push(s); console.log("·", s); };
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`pageerror ${page.url()}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console ${page.url()}: ${m.text().slice(0, 200)}`); });
  page.on("dialog", (d) => d.accept());
  try {
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Sign in for development" }).click();
    await page.getByRole("heading", { name: "Board" }).waitFor({ timeout: 10000 });
    step("signed in, board shown");

    await page.getByRole("button", { name: "New request" }).click();
    const form = page.locator("form").filter({ hasText: "What do you need?" });
    await form.getByLabel("What do you need?").fill("Click-through: add a FAQ line");
    await form.getByLabel("Details").fill("Add one line to CHANGELOG.md saying the click-through ran.");
    await form.getByLabel("Project").selectOption({ label: "Demo (remote)" });
    await form.getByRole("button", { name: "Send request" }).click();
    step("request sent");
    await page.waitForTimeout(1500);
    const items = await (await ctx.request.get(base + "/api/items?limit=1")).json();
    const id = items[0].id;
    await page.goto(`${base}/items/${id}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: /Click-through/ }).waitFor({ timeout: 10000 });
    step(`item #${id} page opened`);
    let status = "";
    for (let i = 0; i < 60; i++) {
      status = (await (await ctx.request.get(`${base}/api/items/${id}`)).json()).item.status;
      if (["done", "blocked", "failed"].includes(status)) break;
      await page.waitForTimeout(2000);
    }
    step(`item #${id} ended ${status} (watched live on the page)`);
    for (const tab of ["Changes", "Runs", "Messages", "Timeline"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).or(page.getByRole("button", { name: new RegExp(`^${tab}`) })).first().click();
      await page.waitForTimeout(400);
      step(`tab ${tab}`);
    }
    await page.screenshot({ path: path.join(out, "click-item.png"), fullPage: true });

    await page.goto(base + "/projects", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add from this Mac" }).click();
    await page.getByText("Add from this Mac").first().waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, "click-discover.png"), fullPage: true });
    await page.keyboard.press("Escape");
    step("discover sheet opened and closed");
    await page.goto(base + "/projects/2", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Edit" }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, "click-project-edit.png"), fullPage: true });
    step("project edit form opened");

    await page.goto(base + "/sources", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Add (a )?source/ }).first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, "click-add-source.png"), fullPage: true });
    await page.keyboard.press("Escape");
    step("add-source sheet opened and closed");

    await page.goto(base + "/settings", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.waitForTimeout(800);
    await page.getByPlaceholder("Laptop CLI").fill("click-through token");
    await page.getByRole("button", { name: "Create token" }).click();
    await page.waitForTimeout(800);
    const shown = await page.getByText(/ft_[A-Za-z0-9_-]{10,}/).count();
    step(`settings saved; token created and shown: ${shown > 0}`);

    for (const p of ["/people", "/metrics", "/book", "/activity", "/inbox"]) {
      await page.goto(base + p, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      step(`page ${p}`);
    }
  } catch (e) {
    problems.push(`FAILED at step ${steps.length + 1}: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(out, "click-failure.png"), fullPage: true }).catch(() => {});
  }
  await browser.close();
  console.log(`\n${steps.length} steps; ${problems.length} problem(s)`);
  for (const p of problems) console.log("!", p);
  process.exit(problems.length ? 1 : 0);
})();
