// The CLI against a stand-in API: the bearer token, the server's error message, SSE parsing,
// argument parsing and per-command flags, `factory show` paging the history, and `factory watch`
// following an item to its end with an exit code per outcome.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ApiError, client, sse } from "../cli/client.ts";
import { UsageError, ago, main, parseArgs, table } from "../cli/factory.ts";

/** Item 11 has a history longer than one page of the events endpoint. */
const LONG = 2005;
const longEvent = (id: number) => ({ id, type: "log", level: "info", message: `step ${id}`, data: null, actor: "factory", at: new Date().toISOString() });

const seen: Array<{ method: string; url: string; auth?: string; body: string }> = [];
let server: http.Server;
let url = "";
let streamPlan: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const json = (code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.headers.authorization !== "Bearer ft_test") return json(401, { error: "login required" });
      if (req.url === "/api/status") return json(200, { paused: false, held: null, active: [{ itemId: 3, kind: "build", startedAt: new Date().toISOString() }], counts: [{ status: "building", n: 1 }], today: { done: 2, created: 4 }, waiting: [] });
      if (req.url === "/api/projects") return json(200, [{ id: 7, slug: "web", name: "Web", delivery: "local", runner: null, paused: false, open: 1, done: 0, default_branch: "main" }]);
      if (req.url === "/api/items" && req.method === "POST") return json(201, { id: 12, title: JSON.parse(body).title, status: "inbox", gate: null });
      if (req.url === "/api/items/5/approve") return json(409, { error: "nothing is waiting for approval" });
      if (req.url?.startsWith("/api/items/9/events")) return json(200, [{ id: 1, type: "status", level: "info", message: "arrived", data: { status: "inbox" }, actor: "ada", at: new Date().toISOString() }]);
      if (req.url === "/api/items/9") return json(200, { item: { id: 9, status: "building", gate: null } });
      if (req.url?.startsWith("/api/items/11/events")) {
        const u = new URL(req.url, "http://x");
        const from = Number(u.searchParams.get("after") || 0), limit = Number(u.searchParams.get("limit") || 2000);
        const ids = [];
        for (let i = from + 1; i <= LONG && ids.length < limit; i++) ids.push(i);
        return json(200, ids.map(longEvent));
      }
      if (req.url === "/api/items/11") return json(200, { item: { id: 11, title: "Long one", body: "", status: "building", gate: null, priority: 3, kind: null, cost_usd: 0, turns: 0, plan: { summary: "partial plan" } }, runs: [], approvals: [], project: { slug: "web" }, active: false, pending: null });
      if (req.url?.startsWith("/api/items/13/events")) return json(200, []);
      if (req.url === "/api/items/13") return json(200, { item: { id: 13, status: "blocked", gate: null } });
      if (req.url === "/api/events/stream?item=13") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: hello\ndata: {}\n\n"); return; }
      if (req.url === "/api/events/stream?item=9") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of streamPlan) { res.write(chunk); await new Promise((r) => setTimeout(r, 20)); }
        return res.end();
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const ev = (id: number, status: string) => `event: event\nid: ${id}\ndata: ${JSON.stringify({ id, type: "status", level: "info", message: status, data: { status }, actor: "factory", at: new Date().toISOString() })}\n\n`;

test("client: the token as a bearer, JSON both ways, the server's error message", async () => {
  const api = client({ url: `${url}/`, token: "ft_test" });
  assert.equal(api.url, url);
  const s = await api.get<{ today: { done: number } }>("/api/status");
  assert.equal(s.today.done, 2);
  const it = await api.post<{ id: number; title: string }>("/api/items", { title: "Hello" });
  assert.deepEqual(it, { id: 12, title: "Hello", status: "inbox", gate: null });
  assert.equal(seen.at(-1)!.auth, "Bearer ft_test");
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { title: "Hello" });
  await assert.rejects(api.post("/api/items/5/approve"), (e: unknown) => e instanceof ApiError && e.status === 409 && e.message === "nothing is waiting for approval");
  await assert.rejects(client({ url, token: "" }).get("/api/status"), /login required \(set FACTORY_TOKEN/);
  await assert.rejects(client({ url: "http://127.0.0.1:9", token: "x" }).get("/api/status"), /cannot reach the factory at http:\/\/127\.0\.0\.1:9/);
});

test("sse: messages split across chunks, comments and multi-line data", async () => {
  const text = ": hello\n\nevent: hello\ndata: {\"a\":1}\n\nid: 7\nevent: event\ndata: line one\ndata: line two\n\ndata: plain\r\n\r\n";
  const parts = [text.slice(0, 5), text.slice(5, 23), text.slice(23, 60), text.slice(60)];
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } });
  const got = [];
  for await (const m of sse(body)) got.push(m);
  assert.deepEqual(got, [
    { event: "hello", data: '{"a":1}', id: undefined },
    { event: "event", data: "line one\nline two", id: "7" },
    { event: "message", data: "plain", id: undefined },
  ]);
});

test("parseArgs: flags with values, booleans, repeats, stdin dash", () => {
  assert.deepEqual(parseArgs(["new", "web", "Fix", "it", "--body", "-", "--priority=2", "--label", "a", "--label", "b", "--json"]), { pos: ["new", "web", "Fix", "it"], flags: { body: "-", priority: "2", label: ["a", "b"], json: true } });
  assert.deepEqual(parseArgs(["ls", "--open", "--status", "review,blocked"]), { pos: ["ls"], flags: { open: true, status: "review,blocked" } });
  assert.deepEqual(parseArgs(["comment", "3", "--", "--not-a-flag"]), { pos: ["comment", "3", "--not-a-flag"], flags: {} });
  assert.throws(() => parseArgs(["ls", "--project"]), /--project needs a value/);
  assert.throws(() => parseArgs(["ls", "--open=yes"]), (e: unknown) => e instanceof UsageError && /--open takes no value/.test(e.message));
});

test("main: each command takes only its own flags, numbers are checked, a change request needs a comment", async () => {
  process.env.FACTORY_URL = url;
  process.env.FACTORY_TOKEN = "ft_test";
  const usage = (re: RegExp) => (e: unknown) => e instanceof UsageError && re.test(e.message);
  const before = seen.length;
  await assert.rejects(main(["ls", "--bogus", "x"]), usage(/factory ls does not take --bogus/));
  await assert.rejects(main(["show", "3", "--open"]), usage(/factory show does not take --open/));
  await assert.rejects(main(["approve", "3", "--priority", "2"]), usage(/does not take --priority/));
  await assert.rejects(main(["ls", "--limit", "ten"]), usage(/--limit is a number from 1 to 500, got "ten"/));
  await assert.rejects(main(["ls", "--limit", "0"]), usage(/--limit is a number/));
  await assert.rejects(main(["new", "web", "Title", "--priority", "9"]), usage(/--priority is 1 \(highest\) to 5/));
  await assert.rejects(main(["new", "web", "Title", "--priority", "2.5"]), usage(/--priority is 1/));
  await assert.rejects(main(["review", "3", "changes"]), usage(/needs a comment/));
  await assert.rejects(main(["review", "3", "maybe"]), usage(/usage: factory review/));
  assert.equal(seen.length, before, "nothing reached the API");
  const err = console.error;
  console.error = () => {};
  try { assert.equal(await main(["frobnicate"]), 4); } finally { console.error = err; }
});

test("the binary exits 4 on a usage or network error", () => {
  const bin = path.join(import.meta.dirname, "..", "cli", "factory.ts");
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  const bad = run(["ls", "--bogus", "x"]);
  assert.equal(bad.status, 4);
  assert.match(bad.stderr, /does not take --bogus[\s\S]*factory --help/);
  const down = run(["status"], { FACTORY_URL: "http://127.0.0.1:9", FACTORY_TOKEN: "x" });
  assert.equal(down.status, 4);
  assert.match(down.stderr, /cannot reach the factory/);
});

test("table and ago format for a terminal", () => {
  const t = table(["id", "title"], [["#1", "short"], ["#22", "a much longer title that will be cut"]], 20);
  assert.deepEqual(t.split("\n"), ["id   title", "#1   short", "#22  a much longer…"]);
  const now = Date.parse("2026-10-31T12:00:00Z");
  assert.equal(ago("2026-10-31T11:59:30Z", now), "30s ago");
  assert.equal(ago("2026-10-31T11:00:00Z", now), "1h ago");
  assert.equal(ago(null, now), "");
});

test("main: commands talk to the API and errors exit non-zero", async () => {
  process.env.FACTORY_URL = url;
  process.env.FACTORY_TOKEN = "ft_test";
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    assert.equal(await main(["status"]), 0);
    assert.ok(lines.some((l) => l.includes("Today: 4 arrived, 2 done")));
    assert.equal(await main(["new", "web", "Add", "a", "button", "--priority", "2", "--label", "ui"]), 0);
    assert.deepEqual(JSON.parse(seen.at(-1)!.body), { title: "Add a button", projectId: 7, priority: 2, labels: ["ui"] });
    await assert.rejects(main(["new", "nope", "Title"]), /no project "nope"/);
    await assert.rejects(main(["approve", "5"]), /nothing is waiting for approval/);
    await assert.rejects(main(["show", "abc"]), /expected an item id/);
    assert.equal(await main([]), 4, "no command prints the usage and fails");
    assert.equal(await main(["--help"]), 0);
  } finally { console.log = log; }
});

test("show: pages through the whole history, prints the newest 15, --json has them all", async () => {
  process.env.FACTORY_URL = url;
  process.env.FACTORY_TOKEN = "ft_test";
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const from = seen.length;
    assert.equal(await main(["show", "11"]), 0);
    const pages = seen.slice(from).filter((r) => r.url.startsWith("/api/items/11/events")).map((r) => new URL(r.url, "http://x").searchParams.get("after"));
    assert.deepEqual(pages, ["0", "2000"], "a full page asks for the next one; the short one ends it");
    const text = lines.join("\n");
    assert.match(text, /Latest events \(15 of 2005\)/);
    assert.ok(text.includes("step 2005") && text.includes("step 1991") && !/step 1990\b/.test(text), "the newest 15, not the oldest");
    assert.match(text, /partial plan/, "a plan without steps still prints");
    lines.length = 0;
    assert.equal(await main(["show", "11", "--json"]), 0);
    const j = JSON.parse(lines.join("\n")) as { events: Array<{ id: number }> };
    assert.equal(j.events.length, LONG);
    assert.equal(j.events.at(-1)!.id, LONG);
  } finally { console.log = log; }
});

test("watch: prints what happened, follows the stream, exits by outcome", async () => {
  process.env.FACTORY_URL = url;
  process.env.FACTORY_TOKEN = "ft_test";
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    streamPlan = ["event: hello\ndata: {}\n\n", ev(1, "inbox"), ev(2, "building").slice(0, 30), ev(2, "building").slice(30), ev(3, "verifying"), ev(4, "done"), ev(5, "never-printed")];
    assert.equal(await main(["watch", "9"]), 0);
    assert.equal(lines.filter((l) => l.includes("arrived")).length, 1, "the existing event once, not again from the stream");
    assert.ok(lines.some((l) => l.includes("building")) && lines.some((l) => l.includes("verifying")));
    assert.ok(!lines.some((l) => l.includes("never-printed")));
    streamPlan = [ev(6, "failed")];
    assert.equal(await main(["watch", "9"]), 1);
    streamPlan = [ev(7, "cancelled")];
    assert.equal(await main(["watch", "9", "--json"]), 2);
    assert.equal(JSON.parse(lines.at(-1)!).data.status, "cancelled");
    streamPlan = [ev(8, "blocked")];
    assert.equal(await main(["watch", "9"]), 3, "blocked ends the watch too");
    assert.equal(await main(["watch", "13"]), 3, "an item already blocked ends it at once");
  } finally { console.log = log; }
});
