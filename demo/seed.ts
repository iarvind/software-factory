#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Sets up the demo: a copy of demo/app as a git repository under data/demo/repo, registered as
// the project "demo" (local delivery, tests as the verify gate, manual gates), and a first
// request for it. Needs the server running on FACTORY_URL (default http://127.0.0.1:8282) and
// either DEV_LOGIN=1 on the server or FACTORY_TOKEN in the environment.
//
//   node demo/seed.ts                        # claude runner (the real thing)
//   DEMO_RUNNER=fake node demo/seed.ts       # no model: just watch the pipeline move
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL_ = (process.env.FACTORY_URL || "http://127.0.0.1:8282").replace(/\/+$/, "");
const TOKEN = process.env.FACTORY_TOKEN || "";
const RUNNER = process.env.DEMO_RUNNER || "claude";
const repo = path.join(process.env.FACTORY_DATA ? path.resolve(process.env.FACTORY_DATA) : path.join(ROOT, "data"), "demo", "repo");

let cookie = "";
async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${URL_}${p}`, { method, headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

// 1. the repository
if (!fs.existsSync(path.join(repo, ".git"))) {
  fs.mkdirSync(repo, { recursive: true });
  fs.cpSync(path.join(ROOT, "demo", "app"), repo, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@localhost", GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@localhost" } });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "factory-demo: a tiny service to practise on");
  console.log(`repository: ${repo}`);
} else console.log(`repository already there: ${repo}`);

// 2. a session
if (!TOKEN) {
  // Sign in as the factory's first admin (from .env next to the server) so the demo account is not left pending.
  const envFile = fs.existsSync(path.join(ROOT, ".env")) ? fs.readFileSync(path.join(ROOT, ".env"), "utf8") : "";
  const admin = /^ADMIN_EMAILS=([^\s,]+)/m.exec(envFile)?.[1];
  const email = process.env.DEMO_EMAIL || admin || "demo@factory.test";
  await api("POST", "/api/auth/dev", { email, name: "Demo" }).catch((e) => { throw new Error(`dev login failed (${e.message}); set DEV_LOGIN=1 on the server or FACTORY_TOKEN here`); });
}

// 3. the project
type Project = { id: number; slug: string };
const projects = await api<Project[]>("GET", "/api/projects");
let project = projects.find((p) => p.slug === "demo");
if (!project) {
  project = await api<Project>("POST", "/api/projects", {
    slug: "demo", name: "Demo service", description: "A tiny Node service the factory practises on (demo/app).",
    local_path: repo, default_branch: "main", delivery: "local", runner: RUNNER,
    test_command: "npm test", gates: { plan: "manual", merge: "manual", deploy: "off", review: RUNNER === "fake" ? "off" : "ai" },
    limits: { maxTurns: 60, maxBudgetUsd: 3, maxMinutes: 20, maxFixRounds: 2, concurrency: 1, verifyMinutes: 5, maxInReview: 3 },
    instructions: "This is a demo repository: plain Node, ES modules, no dependencies. Every function in lib.js has a test in test/.",
  });
  console.log(`project #${project.id} demo (runner ${RUNNER})`);
} else console.log(`project already there: #${project.id}`);

// 4. the first request
const item = await api<{ id: number; status: string }>("POST", "/api/items", {
  projectId: project.id, priority: 2, labels: ["demo"],
  title: "Add a /health endpoint",
  body: "Add GET /health to server.js that answers 200 with JSON {\"ok\": true, \"uptime\": <seconds since start>}. Add a test for it in test/ (you can call handle() with a fake request/response, or start the server on a random port). Mention the endpoint in README.md.",
});
console.log(`item #${item.id} (${item.status}) — open ${URL_}/items/${item.id}`);
console.log("The planner will ask for approval of the plan; approve it on the board, on Telegram, or with: factory approve " + item.id);
