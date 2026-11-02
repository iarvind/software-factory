// MCP servers: which values count as keys and stay hidden, how a form sends them back unchanged, and
// reading the servers Claude Code already has on this machine.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HIDDEN, claudeServers, describe, maskMcp, unmaskMcp } from "../server/lib/mcp.ts";
import { tempDir } from "./helpers.ts";

const H = HIDDEN;

test("maskMcp hides keys and leaves the rest readable", () => {
  const shown = maskMcp({
    pg: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgres://app:hunter2@db.local:5432/app", "--api-key=abc", "--token", "t0k", "--port=5432", "${DSN}", "/Users/me/very/long/path/that/is/not/a/key/at/all/xyz"] },
    tok: { command: "x", args: ["sk1234567890abcdefghijklmnopqrstuvwxyz"] },
    web: { type: "http", url: "https://mcp.example.com/sse?api_key=s3cret&region=eu", headers: { Authorization: "Bearer ${TOKEN}", "X-Key": "raw" } },
    env: { command: "y", env: { A: "plain", B: "${B}" } },
  });
  assert.deepEqual(shown.pg.args, ["-y", "@modelcontextprotocol/server-postgres", `postgres://app:${H}@db.local:5432/app`, `--api-key=${H}`, "--token", H, "--port=5432", "${DSN}", "/Users/me/very/long/path/that/is/not/a/key/at/all/xyz"]);
  assert.deepEqual(shown.tok.args, [H], "a long opaque string");
  assert.equal(shown.web.url, `https://mcp.example.com/sse?api_key=${H}&region=eu`);
  assert.deepEqual(shown.web.headers, { Authorization: "Bearer ${TOKEN}", "X-Key": H });
  assert.deepEqual(shown.env.env, { A: H, B: "${B}" });
});

test("unmaskMcp: what comes back as it was shown keeps the saved value, also when moved; a stray HIDDEN is refused", () => {
  const saved = { pg: { command: "npx", args: ["--token", "t0k", "postgres://app:hunter2@db/app"], env: { KEY: "k1" }, url: undefined } };
  const shown = maskMcp(saved);
  assert.deepEqual(unmaskMcp(shown, saved), saved);
  // The form moved one argument, added one, changed an env value, added a server without keys.
  const back = unmaskMcp({ pg: { ...shown.pg, args: [shown.pg.args![2], "--verbose", "--token", shown.pg.args![1]], env: { KEY: "k2" } }, other: { command: "z" } }, saved);
  assert.deepEqual(back.pg.args, ["postgres://app:hunter2@db/app", "--verbose", "--token", "t0k"]);
  assert.deepEqual(back.pg.env, { KEY: "k2" });
  assert.throws(() => unmaskMcp({ pg: { command: "npx", env: { NEW: H } } }, saved), /pg env NEW has no saved value/);
  assert.throws(() => unmaskMcp({ copy: shown.pg }, saved), /no saved value/, "a server's hidden values do not follow it to another name");
});

const home = tempDir("factory-claude-");
after(() => { fs.rmSync(home, { recursive: true, force: true }); delete process.env.CLAUDE_CONFIG_DIR; });

test("claudeServers: user and local scope from Claude Code's config, project scope from .mcp.json; describe shows names, not values", async () => {
  process.env.CLAUDE_CONFIG_DIR = home;
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { grafana: { type: "stdio", command: "mcp-grafana", args: [], env: { GRAFANA_URL: "https://g.example.com", GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa_secret" } } },
    projects: {
      "/work/other": { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_secret" } } } },
      "/work/empty": { mcpServers: {} },
      "/work/odd": { mcpServers: { "bad name": { command: "x" }, nothing: { args: ["a"] } } },
    },
    oauthAccount: { emailAddress: "someone@example.com" },
  }));
  fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { db: { command: "npx", args: ["server-postgres", "postgres://u:pw@h/db"] } } }));

  const { config, found } = await claudeServers([repo, repo]);
  assert.equal(config, path.join(home, ".claude.json"));
  assert.deepEqual(found.map((f) => `${f.scope}:${f.name}`), ["user:grafana", "local:linear", "project:db"], "unnamed or shapeless entries are skipped; a folder is read once");
  assert.equal(found[1].where, "/work/other");
  assert.equal(found[0].server.env!.GRAFANA_SERVICE_ACCOUNT_TOKEN, "glsa_secret", "the copy keeps the values");

  const seen = JSON.stringify(found.map(describe));
  for (const secret of ["glsa_secret", "lin_secret", "pw@", "g.example.com"]) assert.ok(!seen.includes(secret), secret);
  assert.deepEqual(describe(found[0]).env, ["GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN"]);
  assert.deepEqual(describe(found[1]).headers, ["Authorization"]);

  fs.rmSync(path.join(home, ".claude.json"));
  assert.deepEqual((await claudeServers([])).found, [], "no config, nothing found");
});
