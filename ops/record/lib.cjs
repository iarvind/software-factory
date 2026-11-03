// Shared pieces for the README recordings: a headless Chrome at 1280×800, a visible pointer,
// local paths shortened on screen, a frame-by-frame screencast (CDP) with named marks, and
// the dev sign-in. encode.cjs turns the frames into a GIF and a full-speed MP4.
// Uses the Chrome on this Mac through playwright-core (not a dependency: install it anywhere and
// point PLAYWRIGHT_CORE at it, or have it resolvable from here).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

const ROOT = path.resolve(__dirname, "..", "..");
const BASE = process.env.BASE || "http://127.0.0.1:8282";
const W = 1280, H = 800;
const envFile = path.join(ROOT, ".env");
const EMAIL = process.env.EMAIL || (fs.existsSync(envFile) ? /^ADMIN_EMAILS=([^\s,]+)/m.exec(fs.readFileSync(envFile, "utf8"))?.[1] : "") || "demo@factory.test";
const MEDIA = path.join(ROOT, "data", "media");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const USER = os.userInfo().username;
/** Makes text safe to show: this checkout's path dropped, the home directory as ~, the login name as "me". */
const clean = (s) => s.split(ROOT + "/").join("").split(os.homedir()).join("~").replace(new RegExp(`\\b${esc(USER)}\\b`, "g"), "me");

// Runs in every page before its own scripts: the same cleaning on every text node as it appears,
// so a screenshot or recording does not show where things live on this machine or who runs it.
const SCRUB = `(() => {
  const PARTS = ${JSON.stringify([ROOT + "/", os.homedir()])}, USER = new RegExp(${JSON.stringify(`\\b${esc(USER)}\\b`)}, "g");
  const fix = (s) => s.split(PARTS[0]).join("").split(PARTS[1]).join("~").replace(USER, "me");
  const dirty = (s) => s.includes(PARTS[1]) || (USER.lastIndex = 0, USER.test(s));
  const scrub = (node) => {
    if (node.nodeType === 3) { if (dirty(node.nodeValue)) node.nodeValue = fix(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) if (dirty(t.nodeValue)) t.nodeValue = fix(t.nodeValue);
  };
  new MutationObserver((ms) => { for (const m of ms) { if (m.type === "characterData") scrub(m.target); else m.addedNodes.forEach(scrub); } })
    .observe(document, { subtree: true, childList: true, characterData: true });
})();`;

// Also before every page's scripts: a pointer, a DOM element that follows mouse events
// (headless Chrome draws none), and hidden scrollbars.
const INIT = SCRUB + `(() => {
  const style = document.createElement("style");
  style.textContent = "html{scrollbar-width:none} ::-webkit-scrollbar{display:none}" +
    "#__ptr{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))}" +
    ".__ring{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(37,99,235,.85);z-index:2147483646;pointer-events:none;animation:__ring .45s ease-out forwards}" +
    "@keyframes __ring{from{transform:scale(.3);opacity:1}to{transform:scale(1.2);opacity:0}}";
  const ptr = document.createElement("div");
  ptr.id = "__ptr";
  ptr.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.2 14 L10 20.5 L12.8 19.3 L10.1 13 L16 13 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const mount = () => { document.documentElement.appendChild(style); document.documentElement.appendChild(ptr); const p = window.__ptrAt; if (p) ptr.style.transform = "translate(" + (p[0] - 3) + "px," + (p[1] - 2) + "px)"; };
  if (document.documentElement) mount(); else document.addEventListener("DOMContentLoaded", mount);
  addEventListener("mousemove", (e) => { window.__ptrAt = [e.clientX, e.clientY]; ptr.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)"; }, true);
  addEventListener("mousedown", (e) => { const r = document.createElement("div"); r.className = "__ring"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px"; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 500); }, true);
})();`;

async function launch() {
  return chromium.launch({ channel: "chrome", headless: true });
}

/** A light-theme 1280×800 context with the pointer and the path scrubber; signed in unless told not to. */
async function context(browser, { signIn = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "no-preference" });
  await ctx.addInitScript(INIT);
  if (signIn) await login(ctx);
  return ctx;
}

async function login(ctx) {
  const r = await ctx.request.post(BASE + "/api/auth/dev", { data: { email: EMAIL, name: "Ada" }, headers: { origin: BASE } });
  if (!r.ok()) throw new Error(`dev login failed: ${r.status()} ${await r.text()}`);
}

/** JSON API calls with the context's cookie (non-GET requests carry Origin for the CSRF check). */
function api(ctx) {
  const call = async (method, p, data) => {
    const r = await ctx.request.fetch(BASE + p, { method, data, headers: { origin: BASE, "content-type": "application/json" } });
    const text = await r.text();
    if (!r.ok()) throw new Error(`${method} ${p} → ${r.status()}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  return { get: (p) => call("GET", p), post: (p, d) => call("POST", p, d ?? {}), patch: (p, d) => call("PATCH", p, d) };
}

/** Starts a CDP screencast of the page into dir: one PNG per repaint, with its timestamp; mark() names moments for the edit. */
async function record(page, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [], marks = [];
  let n = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const png = Buffer.from(f.data, "base64");
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    if (png.readUInt32BE(16) !== W || png.readUInt32BE(20) !== H) return; // a frame from before the viewport settled
    const file = `f${String(n++).padStart(5, "0")}.png`;
    fs.writeFileSync(path.join(dir, file), png);
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const start = Date.now() / 1000;
  const mark = (name) => { const t = Date.now() / 1000; marks.push({ name, t }); console.log(`  [${(t - start).toFixed(1)}s] ${name}`); };
  mark("start");
  return {
    mark,
    async stop() {
      mark("end");
      await sleep(300);
      await cdp.send("Page.stopScreencast").catch(() => {});
      fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify({ frames, marks }, null, 1));
      console.log(`  ${frames.length} frames in ${dir}`);
    },
  };
}

/** A pointer that glides: moves the mouse in small steps so the drawn pointer travels, then clicks. */
function pointer(page) {
  let at = [W / 2, H / 2];
  const glide = async (x, y, ms = 600) => {
    const steps = Math.max(8, Math.round(ms / 16));
    const [x0, y0] = at;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
      await sleep(ms / steps);
    }
    at = [x, y];
  };
  const centre = async (loc) => {
    await loc.waitFor({ state: "visible" });
    const b = await loc.boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  return {
    glide,
    async to(loc, ms) { const [x, y] = await centre(loc); await glide(x, y, ms); },
    async click(loc, ms = 650) { const [x, y] = await centre(loc); await glide(x, y, ms); await sleep(180); await page.mouse.down(); await sleep(70); await page.mouse.up(); await sleep(150); },
    async park(x, y, ms = 500) { await glide(x, y, ms); },
  };
}

/** Smooth scroll of the window to y (or by dy), with an ease, over ms. */
async function scrollTo(page, y, ms = 700) {
  await page.evaluate(([to, dur]) => new Promise((done) => {
    const from = window.scrollY, max = document.documentElement.scrollHeight - innerHeight, target = Math.max(0, Math.min(max, to));
    const t0 = performance.now();
    const step = (now) => { const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; window.scrollTo(0, from + (target - from) * e); if (k < 1) requestAnimationFrame(step); else done(); };
    requestAnimationFrame(step);
  }), [y, ms]);
}
const scrollBy = async (page, dy, ms) => scrollTo(page, (await page.evaluate(() => window.scrollY)) + dy, ms);
/** Scroll so that an element's top sits `offset` px below the top of the viewport. */
async function scrollToEl(page, loc, offset = 80, ms = 700) {
  const y = await loc.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await scrollTo(page, y - offset, ms);
}

module.exports = { chromium, ROOT, BASE, W, H, EMAIL, MEDIA, SCRUB, clean, sleep, launch, context, login, api, record, pointer, scrollTo, scrollBy, scrollToEl };
