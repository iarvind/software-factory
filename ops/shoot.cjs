#!/usr/bin/env node
// Screenshots of every page: desktop light, desktop dark, phone light.
//   node ops/shoot.cjs <outdir>            (BASE=http://127.0.0.1:8282 by default)
// Uses the Chrome installed on this Mac through playwright-core (see ops/record/lib.cjs), with
// local paths and the login name cleaned off the pages. Signs in with the dev login
// (DEV_LOGIN=1 on the server) as the first ADMIN_EMAILS address from .env.
const fs = require("node:fs");
const path = require("node:path");
const { chromium, SCRUB } = require("./record/lib.cjs");
const out = process.argv[2] || path.join(__dirname, "..", "data", "shots");
const base = process.env.BASE || "http://127.0.0.1:8282";
const item = process.env.ITEM || "1";
const pages = ["/", `/items/${item}`, "/inbox", "/projects", "/projects/1", "/sources", "/people", "/metrics", "/book", "/activity", "/settings"];
const envFile = path.join(__dirname, "..", ".env");
const email = process.env.EMAIL || (fs.existsSync(envFile) ? /^ADMIN_EMAILS=([^\s,]+)/m.exec(fs.readFileSync(envFile, "utf8"))?.[1] : "") || "demo@factory.test";
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const modes = [
    { name: "desktop", viewport: { width: 1380, height: 900 }, colorScheme: "light" },
    { name: "dark", viewport: { width: 1380, height: 900 }, colorScheme: "dark" },
    { name: "phone", viewport: { width: 390, height: 844 }, colorScheme: "light", isMobile: true, deviceScaleFactor: 2 },
  ];
  const problems = [];
  for (const m of modes) {
    const ctx = await browser.newContext({ viewport: m.viewport, colorScheme: m.colorScheme, isMobile: m.isMobile, deviceScaleFactor: m.deviceScaleFactor ?? 1 });
    await ctx.addInitScript(SCRUB);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => problems.push(`${m.name}: pageerror ${e.message}`));
    page.on("console", (msg) => { if (msg.type() === "error") problems.push(`${m.name} ${page.url()}: ${msg.text().slice(0, 200)}`); });
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(out, `${m.name}-login.png`) });
    const r = await ctx.request.post(base + "/api/auth/dev", { data: { email, name: "Ada" } });
    if (!r.ok()) { problems.push(`dev login failed: ${r.status()} ${await r.text()}`); break; }
    for (const p of pages) {
      await page.goto(base + p, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, `${m.name}${p.replace(/\//g, "-") || "-board"}.png`), fullPage: p !== "/" });
    }
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(out, "problems.txt"), problems.join("\n"));
  console.log(`${pages.length * modes.length + modes.length} screenshots in ${out}; ${problems.length} console/page problem(s)`);
  if (problems.length) console.log(problems.slice(0, 20).join("\n"));
})();
