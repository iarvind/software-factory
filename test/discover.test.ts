// Offering the apps already on this Mac as projects: which checkouts under rack's roots are found,
// and what each one's commands are guessed to be.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitIn, skipIfNoDb, tempDir, useTestDb } from "./helpers.ts";

// discover.ts reads rack's roots from $HOME/Self/dashboard/services.json, with HOME read when it is
// imported: a throwaway HOME stands in for this Mac's, so the roots are ours.
const realHome = process.env.HOME;
const HOME = tempDir("factory-home-");
process.env.HOME = HOME;

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = (file: string, v: unknown) => write(file, `${JSON.stringify(v, null, 2)}\n`);

describe("discover: checkouts under the roots, with suggested commands", { skip: skipIfNoDb }, () => {
  let db: Awaited<ReturnType<typeof useTestDb>>;
  let discover: typeof import("../server/lib/discover.ts");
  const apps = path.join(HOME, "apps");
  const nodeApp = path.join(apps, "node-app");
  const goSvc = path.join(apps, "go-svc");

  before(async () => {
    db = await useTestDb();
    discover = await import("../server/lib/discover.ts");
    json(path.join(HOME, "Self/dashboard/services.json"), { roots: ["~/apps", "~/not-there"] });
    fs.mkdirSync(apps);

    // A Node project: test, typecheck and build scripts, a lockfile, a .env and installed node_modules.
    gitIn(apps, "init", "-q", "-b", "main", nodeApp);
    json(path.join(nodeApp, "package.json"), { name: "node-app", scripts: { test: "node --test", typecheck: "tsc --noEmit", build: "vite build" }, dependencies: { hono: "^4" } });
    json(path.join(nodeApp, "package-lock.json"), { lockfileVersion: 3 });
    write(path.join(nodeApp, ".env"), "PORT=1234\n");
    fs.mkdirSync(path.join(nodeApp, "node_modules"));
    write(path.join(nodeApp, "README.md"), "# Node app\n\n[![ci](https://x/badge.svg)](https://x)\n\nA shop front for the corner store.\nIt sells bread.\n\n## Running\n\nnpm start\n");

    // A Go module with a Makefile (deploy and test targets, no check) and a dashboard.json service with a health path; on GitHub, branch trunk.
    gitIn(apps, "init", "-q", "-b", "trunk", goSvc);
    gitIn(goSvc, "remote", "add", "origin", "git@github.com:acme/go-svc.git");
    write(path.join(goSvc, "go.mod"), "module example.com/go-svc\n\ngo 1.23\n");
    write(path.join(goSvc, "Makefile"), ".PHONY: deploy test\nVERSION := 1.0\n\ndeploy:\n\t./ops/deploy.sh\n\ntest: vet\n\tgo test ./...\n");
    json(path.join(goSvc, "dashboard.json"), { name: "go-svc", services: [{ name: "web" }, { name: "api", port: 4321, health: "/healthz" }] });

    // Not offered: a worktree (.git is a file), a registered project, a hidden checkout, a folder without git, a file.
    write(path.join(apps, "a-worktree/.git"), "gitdir: /somewhere/else/.git/worktrees/a-worktree\n");
    json(path.join(apps, "a-worktree/package.json"), { scripts: { test: "node --test" } });
    gitIn(apps, "init", "-q", "-b", "main", path.join(apps, "registered"));
    gitIn(apps, "init", "-q", "-b", "main", path.join(apps, ".hidden"));
    fs.mkdirSync(path.join(apps, "notes"));
    write(path.join(apps, "todo.txt"), "milk\n");
    // The same checkout twice, through a symlink: offered once.
    fs.symlinkSync(nodeApp, path.join(apps, "the-node-app-again"));
  });
  beforeEach(async () => { await db.reset(); });
  after(async () => {
    await db?.close();
    fs.rmSync(HOME, { recursive: true, force: true });
    process.env.HOME = realHome;
  });

  test("discover() lists unregistered checkouts one level under each root, by name, with their suggestions", async () => {
    assert.ok((await discover.discover()).candidates.some((c) => c.name === "registered"), "offered until it is registered");
    await db.q("insert into projects (slug, name, local_path) values ('registered', 'registered', '~/apps/registered')");
    const r = await discover.discover();
    assert.deepEqual(r.roots, [apps, path.join(HOME, "not-there")], "the roots come from services.json, ~ expanded; a missing one is not an error");
    assert.deepEqual(r.candidates.map((c) => c.name), ["go-svc", "node-app"]);

    const [go, node] = r.candidates;
    assert.deepEqual(node, {
      path: nodeApp, name: "node-app", slug: "node-app", default_branch: "main", remote: null, github: null,
      suggestions: {
        test_command: "npm test",
        build_command: "npm run typecheck", // typecheck is preferred over build
        deploy_command: null,
        setup_command: `cp '${path.join(nodeApp, ".env")}' .env && npm ci`,
        health_url: null,
        instructions: "A shop front for the corner store. It sells bread.",
      },
    });
    assert.deepEqual(go, {
      path: goSvc, name: "go-svc", slug: "go-svc", default_branch: "trunk", remote: "git@github.com:acme/go-svc.git", github: "acme/go-svc",
      suggestions: {
        test_command: "make test", // the Makefile is asked before go.mod
        build_command: "go build ./...",
        deploy_command: "make deploy",
        setup_command: null,
        health_url: "http://127.0.0.1:4321/healthz",
        instructions: null,
      },
    });
  });

  test("inspectRepo: a checkout by any spelling of its path; not a worktree, a plain folder or nothing", async () => {
    assert.equal((await discover.inspectRepo("~/apps/node-app"))?.path, nodeApp);
    assert.equal((await discover.inspectRepo(path.join(apps, "the-node-app-again")))?.path, nodeApp, "a symlink resolves to the checkout");
    assert.equal(await discover.inspectRepo(path.join(apps, "a-worktree")), null);
    assert.equal(await discover.inspectRepo(path.join(apps, "notes")), null);
    assert.equal(await discover.inspectRepo(path.join(apps, "todo.txt")), null);
    assert.equal(await discover.inspectRepo(path.join(apps, "missing")), null);
  });

  test("suggest(): the other branches of the guesswork", async () => {
    const dir = (name: string) => { const d = path.join(HOME, "plain", name); fs.mkdirSync(d, { recursive: true }); return d; };

    // npm init's placeholder test is not a suite; dependencies with a lockfile and nothing installed is npm ci.
    const ci = dir("ci");
    json(path.join(ci, "package.json"), { scripts: { test: 'echo "Error: no test specified" && exit 1', build: "vite build" }, devDependencies: { vite: "^7" } });
    json(path.join(ci, "package-lock.json"), {});
    let s = await discover.suggest(ci);
    assert.equal(s.test_command, null);
    assert.equal(s.build_command, "npm run build");
    assert.equal(s.setup_command, "npm ci");

    // Without a lockfile, npm install; without dependencies, no setup at all.
    const install = dir("install");
    json(path.join(install, "package.json"), { dependencies: { pg: "^8" } });
    assert.equal((await discover.suggest(install)).setup_command, "npm install");
    const bare = dir("bare");
    json(path.join(bare, "package.json"), { name: "bare" });
    assert.equal((await discover.suggest(bare)).setup_command, null);

    // Python, a Makefile check target, dashboard.json's own deploy and an absolute health URL, CLAUDE.md as the description.
    const py = dir("py");
    write(path.join(py, "pyproject.toml"), "[project]\nname = \"py\"\n");
    write(path.join(py, "Makefile"), "check:\n\truff check .\n");
    json(path.join(py, "dashboard.json"), { deploy: "./ops/ship.sh", services: [{ port: 9000, health: "https://py.example.com/up" }] });
    write(path.join(py, "CLAUDE.md"), "# py\n\nKeep the handlers small.\n");
    s = await discover.suggest(py);
    assert.deepEqual(s, { test_command: "pytest", build_command: "make check", deploy_command: "./ops/ship.sh", setup_command: null, health_url: "https://py.example.com/up", instructions: "Keep the handlers small." });

    // Nothing to go on: nothing guessed.
    assert.deepEqual(await discover.suggest(dir("empty")), { test_command: null, build_command: null, deploy_command: null, setup_command: null, health_url: null, instructions: null });
  });
});
