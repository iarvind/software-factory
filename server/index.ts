import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { migrate } from "./db.ts";
import { HttpError } from "./lib/http.ts";
import { ADMIN_EMAILS, ALLOWED_DOMAINS, ALLOWED_EMAILS, DEV_LOGIN, SESSION_COOKIE, atLeast, authFor, googleConfigured, pruneSessions, type Auth } from "./lib/auth.ts";
import { killAllChildren, registerRunner } from "./lib/runners/index.ts";
import { claudeRunner } from "./lib/runners/claude.ts";
import { fakeRunner } from "./lib/runners/fake.ts";
import { registerBuiltinSources } from "./lib/sources/builtin.ts";
import { startSources, stopSources } from "./lib/sources/index.ts";
import { startPipeline } from "./lib/pipeline.ts";
import { startPrWatch } from "./lib/prwatch.ts";
import { startDigest } from "./lib/digest.ts";
import { notifierConfigured, registerHook } from "./lib/notifier.ts";
import { encryptionConfigured } from "./lib/crypto.ts";
import { authRoutes, meRoutes, type Env } from "./routes/auth.ts";
import { itemRoutes } from "./routes/items.ts";
import { projectRoutes } from "./routes/projects.ts";
import { hookRoutes, sourceRoutes } from "./routes/sources.ts";
import { userRoutes } from "./routes/users.ts";
import { miscRoutes } from "./routes/misc.ts";
import { notifierRoutes } from "./routes/notifier.ts";

const PORT = Number(process.env.PORT || 8282);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "web", "dist");

// Runners and sources that ship with the factory. Others register themselves from their modules.
registerRunner(claudeRunner);
registerRunner(fakeRunner);
for (const mod of ["./lib/runners/codex.ts", "./lib/runners/gemini.ts"]) {
  try { const m = (await import(mod)) as { register?: () => void }; m.register?.(); } catch (e) { if (!(e instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(e.message))) console.warn(`runner ${mod}:`, e instanceof Error ? e.message : e); }
}
registerBuiltinSources();
for (const mod of ["./lib/sources/slack.ts", "./lib/sources/jira.ts", "./lib/sources/github.ts", "./lib/sources/linear.ts"]) {
  try { const m = (await import(mod)) as { register?: () => void }; m.register?.(); } catch (e) { if (!(e instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(e.message))) console.warn(`source ${mod}:`, e instanceof Error ? e.message : e); }
}

const app = new Hono<Env>();

// --- headers every response carries -----------------------------------------
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https://lh3.googleusercontent.com https://*.googleusercontent.com", "font-src 'self'",
  "connect-src 'self'", "manifest-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
].join("; ");
app.use("*", async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "microphone=(), camera=(), geolocation=(), payment=(), usb=()");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
});

// --- cross-site writes are refused whatever the cookie says ------------------------
app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  if (c.req.path.startsWith("/api/hooks/") || c.req.path === "/api/notifier/hook") return next();
  const bearer = c.req.header("authorization");
  if (bearer?.startsWith("Bearer ft_")) return next(); // API tokens are not cookies; no CSRF surface
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return c.json({ error: "cross-site request refused" }, 403);
  const origin = c.req.header("origin");
  if (origin) {
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "";
    let ok = false;
    try { ok = new URL(origin).host === host; } catch { ok = false; }
    if (!ok) return c.json({ error: "cross-site request refused" }, 403);
  }
  return next();
});
app.use("/api/*", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "body too large" }, 413) }));

// --- who is asking ------------------------------------------------------------------
app.use("/api/*", async (c, next) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  c.set("auth", await authFor(getCookie(c, SESSION_COOKIE), bearer));
  return next();
});

app.get("/api/healthz", (c) => c.json({ ok: true }));
app.route("/api", authRoutes);
app.route("/api", hookRoutes);
app.route("/api", notifierRoutes);

// --- the gate: everything else needs a live account that is not pending ----------------
const OPEN_PATHS = new Set(["/api/healthz", "/api/session", "/api/logout", "/api/auth/dev"]);
app.use("/api/*", async (c, next) => {
  if (OPEN_PATHS.has(c.req.path) || c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/api/hooks/") || c.req.path === "/api/notifier/hook") return next();
  const a = c.get("auth");
  if (!a) return c.json({ error: "login required" }, 401);
  if (a.user.role === "pending") return c.json({ error: "your account is waiting for an admin to let you in" }, 403);
  if (!atLeast(a.user, "member") && c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.path !== "/api/logout" && !c.req.path.startsWith("/api/me/")) return c.json({ error: "viewers can look but not change" }, 403);
  return next();
});

app.route("/api", meRoutes);
app.route("/api", itemRoutes);
app.route("/api", projectRoutes);
app.route("/api", sourceRoutes);
app.route("/api", userRoutes);
app.route("/api", miscRoutes);
app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : spa(c.req.path)));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

// --- the built app ----------------------------------------------------------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};
function spa(reqPath: string): Response {
  let decoded = reqPath;
  try { decoded = decodeURIComponent(reqPath); } catch { decoded = "/"; }
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(DIST, safe);
  if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file);
    return new Response(fs.readFileSync(file), { headers: { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": safe.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" } });
  }
  const index = path.join(DIST, "index.html");
  if (!fs.existsSync(index)) return new Response("web/dist is missing — run `npm run build` (or `npm run dev` for the Vite dev server on :5282)", { status: 503, headers: { "Content-Type": "text/plain" } });
  return new Response(fs.readFileSync(index), { headers: { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" } });
}

// --- boot -------------------------------------------------------------------
await migrate();
await pruneSessions();
if (!googleConfigured() && !DEV_LOGIN) console.warn("factory: no sign-in is configured (GOOGLE_CLIENT_ID/_SECRET, or DEV_LOGIN=1 for local use) — nobody can get in");
if (!encryptionConfigured()) console.warn("factory: FACTORY_SECRET is not set — integration secrets (Slack, Jira, GitHub tokens) cannot be stored until it is");
await startPipeline(); // recovery first: nobody should see a stale "building" through the API
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`factory: http://${info.address}:${info.port} (${fs.existsSync(path.join(DIST, "index.html")) ? "serving web/dist" : "no build yet"})${googleConfigured() ? `, google sign-in (admins: ${ADMIN_EMAILS.join(" ") || "first account"}; members: ${[...ALLOWED_EMAILS, ...ALLOWED_DOMAINS.map((d) => `@${d}`)].join(" ") || "by approval"})` : ""}${DEV_LOGIN ? ", dev login on" : ""}${notifierConfigured() ? ", notifier on" : ""}`);
});
startSources();
startPrWatch();
startDigest();
if (notifierConfigured()) { setTimeout(() => registerHook(PORT), 5_000).unref(); setInterval(() => registerHook(PORT), 10 * 60 * 1000).unref(); }
const srv = server as unknown as { requestTimeout: number; headersTimeout: number };
srv.requestTimeout = 15 * 60 * 1000;
srv.headersTimeout = 65 * 1000;
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e instanceof Error ? e.stack ?? e.message : e));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { killAllChildren(); stopSources().finally(() => setTimeout(() => process.exit(0), 500)); });
