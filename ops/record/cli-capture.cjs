#!/usr/bin/env node
// Runs the real `factory` CLI and keeps what it printed, with timings, for cli.cjs to replay in
// a drawn terminal. Three phases, so the change can be looked at in the browser in between:
//   FACTORY_TOKEN=ft_… node ops/record/cli-capture.cjs a   status, new (on the Demo service), watch until the change waits for a person, ^C
//   FACTORY_TOKEN=ft_… node ops/record/cli-capture.cjs b   review approve, approvals (it now waits at the merge gate)
//   FACTORY_TOKEN=ft_… node ops/record/cli-capture.cjs c   approve (the merge gate), wait for done, ls
// Phase a sets the Demo service's gates to plan auto / merge manual / review ai; phase c puts
// back plan auto / merge auto / review ai. The token is used, never printed or saved.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const L = require("./lib.cjs");

const URL_ = process.env.FACTORY_URL || L.BASE;
const TOKEN = process.env.FACTORY_TOKEN;
if (!TOKEN) { console.error("FACTORY_TOKEN is needed"); process.exit(2); }
const DEMO = Number(process.env.DEMO_PROJECT || 2);
const SLUG = process.env.DEMO_SLUG || "demo";
const TITLE = process.env.CLI_TITLE || "Include the requested path in 404 responses";
const FILE = path.join(L.MEDIA, "cli-session.json");
const CLI = path.join(L.ROOT, "cli", "factory.ts");

const clean = (s) => s.replace(/\/Users\/[^/\s"']+\/Self\/software-factory\//g, "").replace(/\/Users\/[^/\s"']+/g, "~").replace(/ft_[A-Za-z0-9_-]{8,}/g, "ft_…");
async function api(method, p, body) {
  const r = await fetch(URL_ + p, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

/** Runs `factory <args>` as if on a terminal (colours on, 120 columns); stop(child) may end it early with ^C. */
function run(args, shown, stop) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = [];
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", 'data:text/javascript,Object.defineProperty(process.stdout,"isTTY",{value:true});Object.defineProperty(process.stdout,"columns",{value:118})', CLI, ...args],
      { env: { ...process.env, FACTORY_URL: URL_, FACTORY_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
    const take = (b) => { const text = clean(b.toString()); out.push({ dt: (Date.now() - t0) / 1000, text }); process.stdout.write(text); };
    child.stdout.on("data", take); child.stderr.on("data", take);
    let interrupted = false;
    if (stop) stop(() => { interrupted = true; child.kill("SIGINT"); });
    child.on("close", (code) => resolve({ cmd: shown, out, exit: code, interrupted }));
  });
}
const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { steps: [] });
const save = (s) => fs.writeFileSync(FILE, JSON.stringify(s, null, 1));
const status = async (id) => (await api("GET", `/api/items/${id}`)).item;

(async () => {
  const phase = process.argv[2];
  if (phase === "a") {
    await api("PATCH", `/api/projects/${DEMO}`, { gates: { plan: "auto", merge: "manual", review: "ai" } });
    const s = { steps: [] };
    s.steps.push(await run(["status"], "factory status"));
    const made = await run(["new", SLUG, TITLE], `factory new ${SLUG} "${TITLE}"`);
    s.steps.push(made);
    const id = Number(/#(\d+) created/.exec(made.out.map((o) => o.text).join(""))?.[1]);
    if (!id) throw new Error("no item id in the output of factory new");
    s.item = id;
    save(s);
    s.steps.push(await run(["watch", String(id)], `factory watch ${id}`, (interrupt) => {
      const poll = setInterval(async () => {
        const it = await status(id).catch(() => null);
        if (!it) return;
        if (it.status === "review" || (it.status === "awaiting_approval" && it.gate === "merge")) { clearInterval(poll); setTimeout(interrupt, 3000); }
        else if (["done", "failed", "cancelled", "blocked", "needs_info"].includes(it.status)) { clearInterval(poll); console.error(`\n#${id} is ${it.status}`); setTimeout(interrupt, 1500); }
      }, 1000);
    }));
    save(s);
    console.log(`\nphase a done: #${id} waits for a person's review. Record the review clip, then run phase b.`);
  } else if (phase === "b") {
    const s = load();
    const id = s.item;
    if ((await status(id)).status === "review") {
      s.steps.push(await run(["review", String(id), "approve", "Reads well; the test covers it"], `factory review ${id} approve "Reads well; the test covers it"`));
      for (let i = 0; i < 30; i++) { const it = await status(id); if (it.status === "awaiting_approval") break; await L.sleep(500); }
    }
    s.steps.push(await run(["approvals"], "factory approvals"));
    save(s);
    console.log(`\nphase b done: #${id} waits at the merge gate (the Board's "Needs you"). Then run phase c.`);
  } else if (phase === "c") {
    const s = load();
    const id = s.item;
    s.steps.push(await run(["approve", String(id), "ship it"], `factory approve ${id} "ship it"`));
    for (let i = 0; i < 120; i++) { const it = await status(id); if (["done", "failed", "blocked", "cancelled"].includes(it.status)) break; await L.sleep(1000); }
    s.steps.push(await run(["ls", "--limit", "5"], "factory ls --limit 5"));
    save(s);
    await api("PATCH", `/api/projects/${DEMO}`, { gates: { plan: "auto", merge: "auto", review: "ai" } });
    console.log("\nphase c done; gates back to plan auto / merge auto / review ai");
  } else { console.error("usage: cli-capture.cjs a|b|c"); process.exit(2); }
})().catch((e) => { console.error(e); process.exit(1); });
