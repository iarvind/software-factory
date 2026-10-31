#!/usr/bin/env node
// Replays data/media/cli-session.json (what the real CLI printed, from cli-capture.cjs) in a
// drawn terminal: each command typed, its output shown with the timing it had (the long
// waits of `factory watch` shortened), and records that in Chrome.   node ops/record/cli.cjs
// (--encode-only makes the GIF again from the frames already recorded.)
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lib.cjs");
const { encode } = require("./encode.cjs");

const session = JSON.parse(fs.readFileSync(path.join(L.MEDIA, "cli-session.json"), "utf8"));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#eceef1;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
.win{position:absolute;left:50px;top:36px;right:50px;bottom:36px;border-radius:11px;background:#16171a;box-shadow:0 18px 50px rgba(0,0,0,.22),0 0 0 1px rgba(0,0,0,.3);overflow:hidden;display:flex;flex-direction:column}
.bar{position:relative;height:36px;flex:none;display:flex;align-items:center;padding:0 14px;background:#232428;border-bottom:1px solid #0b0b0c}
.dot{width:12px;height:12px;border-radius:50%;margin-right:8px;background:#45464b}
.title{position:absolute;left:0;right:0;text-align:center;color:#8e9096;font-size:13px}
.term{flex:1;overflow:hidden;padding:14px 18px 18px;font:13.5px/1.5 Menlo,"SF Mono",monospace;color:#d9dadd;white-space:pre-wrap;overflow-wrap:anywhere}
.b{font-weight:700;color:#f4f4f5}.d{color:#7b7d84}.r{color:#ff7b72}.g{color:#7ee787}.y{color:#e3b341}.c{color:#79c0ff}
.ps{color:#7ee787}.ps2{color:#7b7d84}.cur{display:inline-block;width:8px;height:17px;background:#d9dadd;vertical-align:-3px}
</style></head><body><div class="win"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><div class="title">factory — a terminal on the same machine</div></div><div class="term" id="t"></div></div></body></html>`;

// Runs in the page: S is the session.
function play(S) {
  const t = document.getElementById("t");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const CODES = { 1: "b", 2: "d", 31: "r", 32: "g", 33: "y", 36: "c" };
  const ansi = (s) => {
    let html = "", cls = [];
    for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
      const m = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (m) { for (const c of m[1].split(";")) { if (c === "0" || c === "") cls = []; else if (CODES[c]) cls.push(CODES[c]); } continue; }
      if (part) html += cls.length ? `<span class="${cls.join(" ")}">${esc(part)}</span>` : esc(part);
    }
    return html;
  };
  const down = () => { t.scrollTop = t.scrollHeight; };
  const cursor = document.createElement("span"); cursor.className = "cur";
  const prompt = () => { const line = document.createElement("div"); line.innerHTML = '<span class="ps">~/work</span><span class="ps2"> $ </span>'; const cmd = document.createElement("span"); line.append(cmd, cursor); t.append(line); down(); return cmd; };
  return (async () => {
    await sleep(700);
    for (let i = 0; i < S.steps.length; i++) {
      const step = S.steps[i];
      const watch = /^factory watch/.test(step.cmd);
      const cmd = prompt();
      await sleep(i ? 500 : 900);
      window.__mark(`cmd${i}`);
      for (const ch of step.cmd) { cmd.textContent += ch; await sleep(38 + Math.random() * 34); }
      window.__mark(`typed${i}`);
      await sleep(380);
      cursor.remove();
      const out = document.createElement("div"); t.append(out);
      if (watch) {
        // The stream, with its waits shortened, shown in ticks of 280 ms: lines that arrived within a tick appear together.
        let at = 0, prev = 0;
        const timed = [];
        for (const o of step.out) { at += Math.min(500, Math.max(30, (o.dt - prev) * 1000 / 8)); prev = o.dt; timed.push([at, o.text.replace(/\r/g, "")]); }
        const t0 = performance.now();
        let k = 0;
        while (k < timed.length) {
          await sleep(280);
          const now = performance.now() - t0;
          let html = "";
          while (k < timed.length && timed[k][0] <= now) html += ansi(timed[k++][1]);
          if (html) { out.insertAdjacentHTML("beforeend", html); down(); }
        }
      } else {
        let prev = 0;
        for (const o of step.out) {
          await sleep(Math.min(350, Math.max(0, o.dt - prev) * 1000)); prev = o.dt;
          out.insertAdjacentHTML("beforeend", ansi(o.text.replace(/\r/g, ""))); down();
        }
      }
      if (step.interrupted) { await sleep(1400); out.insertAdjacentHTML("beforeend", '<span class="d">^C</span>\n'); }
      if (out.innerHTML.endsWith("\n")) out.innerHTML = out.innerHTML.replace(/\n$/, "");
      down();
      window.__mark(`out${i}`);
      await sleep(watch ? 1800 : /approvals|status|ls/.test(step.cmd) ? 2200 : 1500);
    }
    prompt();
    await sleep(1600);
  })();
}

(async () => {
  if (process.argv.includes("--encode-only")) return encodeCli();
  const browser = await L.launch();
  const ctx = await L.context(browser, { signIn: false });
  const page = await ctx.newPage();
  // From a file, not setContent: on about:blank the screencast ignores the emulated viewport.
  const html = path.join(L.MEDIA, "frames", "cli-terminal.html");
  fs.mkdirSync(path.dirname(html), { recursive: true });
  fs.writeFileSync(html, PAGE);
  await page.goto("file://" + html);
  const rec = await L.record(page, path.join(L.MEDIA, "frames", "cli"));
  await page.exposeFunction("__mark", (n) => rec.mark(n));
  await page.evaluate(`(${play.toString()})(${JSON.stringify(session)})`);
  await rec.stop();
  await browser.close();
  encodeCli();
})();

function encodeCli() {
  const n = session.steps.length, segments = [{ from: "start+0.5", to: "cmd0", speed: 1 }];
  for (let i = 0; i < n; i++) {
    const watch = /^factory watch/.test(session.steps[i].cmd); // its stream scrolls the whole window on every line: the costly part of the GIF
    segments.push({ from: `cmd${i}`, to: `typed${i}`, speed: 2 }, { from: `typed${i}`, to: `out${i}`, speed: 1 }, { from: `out${i}`, to: i + 1 < n ? `cmd${i + 1}` : "end", speed: 1 });
  }
  encode(path.join(L.MEDIA, "frames", "cli"), { name: "cli", fps: 10, colors: 32, hold: 1, segments });
}
