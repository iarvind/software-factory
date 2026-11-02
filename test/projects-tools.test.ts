// What a project lets its agents reach: folders to read and MCP servers, with the servers' keys kept out of the API's answers.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Hono } from "hono";
import { skipIfNoDb, tempDir, useTestDb } from "./helpers.ts";

describe("project tools: folders and MCP servers", { skip: skipIfNoDb }, () => {
  let db: Awaited<ReturnType<typeof useTestDb>>;
  let app: Hono;
  const shared = tempDir("factory-shared-");
  const call = async (method: string, url: string, body?: unknown, role = "admin") => {
    const res = await app.request(url, { method, headers: { "content-type": "application/json", "x-role": role }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  before(async () => {
    db = await useTestDb();
    const { projectRoutes } = await import("../server/routes/projects.ts");
    const { HttpError } = await import("../server/lib/http.ts");
    const [admin] = await db.q<{ id: number }>("insert into users (email, role) values ('ada@example.com', 'admin') returning id");
    // The real gate signs people in; here a header says who is asking.
    app = new Hono();
    app.use("*", async (c, next) => { (c as any).set("auth", { user: { id: admin.id, email: "ada@example.com", role: c.req.header("x-role"), disabled_at: null }, session: null, via: "token" }); await next(); });
    app.route("/", projectRoutes as never);
    app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));
  });
  after(async () => { await db?.close(); });

  test("MCP keys are hidden in every answer and kept when sent back hidden; ${NAME} references are shown", async () => {
    const mcp = {
      grafana: { command: "mcp-grafana", env: { GRAFANA_URL: "https://grafana.example.com", GRAFANA_API_KEY: "${GRAFANA_API_KEY}", LEGACY_TOKEN: "s3cret" } },
      loki: { type: "http", url: "https://loki.example.com/mcp", headers: { Authorization: "Bearer ${LOKI_TOKEN}", "X-Org": "acme" } },
    };
    const created = await call("POST", "/projects", { slug: "web", name: "Web", local_path: shared, tools: { dirs: [shared], mcp } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const shown = created.body.tools.mcp;
    assert.equal(shown.grafana.env.GRAFANA_API_KEY, "${GRAFANA_API_KEY}");
    assert.equal(shown.grafana.env.LEGACY_TOKEN, "••••••");
    assert.equal(shown.grafana.env.GRAFANA_URL, "••••••", "a plain value could be a key; only references are shown");
    assert.equal(shown.loki.headers.Authorization, "Bearer ${LOKI_TOKEN}");
    assert.deepEqual(created.body.tools.dirs, [shared]);

    for (const r of [await call("GET", `/projects/${created.body.id}`, undefined, "viewer"), await call("GET", "/projects", undefined, "viewer")]) {
      const t = (Array.isArray(r.body) ? r.body[0] : r.body).tools;
      assert.equal(t.mcp.grafana.env.LEGACY_TOKEN, "••••••", "nobody reads a key back");
    }

    // The form sends back what it was shown, with one server changed: the hidden values stay as they were.
    const edited = { ...shown, grafana: { ...shown.grafana, args: ["--debug"] } };
    const patched = await call("PATCH", `/projects/${created.body.id}`, { tools: { mcp: edited } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const [row] = await db.q<{ tools: { mcp: typeof mcp & { grafana: { args: string[] } } } }>("select tools from projects where id = $1", [created.body.id]);
    assert.equal(row.tools.mcp.grafana.env.LEGACY_TOKEN, "s3cret");
    assert.equal(row.tools.mcp.grafana.env.GRAFANA_URL, "https://grafana.example.com");
    assert.deepEqual(row.tools.mcp.grafana.args, ["--debug"]);

    // A hidden value with nothing saved behind it (a new key, or a copy into another project) cannot be saved.
    const fresh = await call("PATCH", `/projects/${created.body.id}`, { tools: { mcp: { ...edited, other: { command: "x", env: { K: "••••••" } } } } });
    assert.equal(fresh.status, 400);
    assert.match(fresh.body.error, /other env K has no saved value/);
  });

  test("folders must be full paths that exist; a server needs a command or a url; only admins change tools", async () => {
    const p = await call("POST", "/projects", { slug: "api", name: "API", local_path: shared });
    assert.equal(p.status, 201);
    assert.deepEqual(p.body.tools.dirs, [], "older and new projects start with none");
    assert.deepEqual(p.body.tools.mcp, {});
    const bad = async (tools: unknown) => (await call("PATCH", `/projects/${p.body.id}`, { tools })).body.error as string;
    assert.match(await bad({ dirs: ["relative/dir"] }), /full path/);
    assert.match(await bad({ dirs: [path.join(shared, "missing")] }), /does not exist on this machine/);
    assert.match(await bad({ mcp: { x: { args: ["a"] } } }), /a command or a url/);
    assert.match(await bad({ mcp: { "bad name": { command: "x" } } }), /tools.mcp.bad name/);
    assert.equal((await call("PATCH", `/projects/${p.body.id}`, { tools: { dirs: [shared] } }, "member")).status, 403);
  });
});
