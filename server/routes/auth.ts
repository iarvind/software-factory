import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import {
  AuthError, DEV_LOGIN, SESSION_COOKIE, SESSION_DAYS, audit, clientIp, createApiToken, createSession, describeAgent, exchangeCode, googleConfigured, isHttps,
  listApiTokens, listSessions, lockedFor, loginUrl, newLoginState, packLoginState, proxied, publicOrigin, recordFailure, recordSuccess, revokeApiToken, revokeOthers, revokeSession,
  unpackLoginState, upsertUser, type Auth,
} from "../lib/auth.ts";
import { HttpError, body, idParam } from "../lib/http.ts";
import { settings } from "../lib/settings.ts";

export type Env = { Variables: { auth: Auth | null } };
const LOGIN_COOKIE = "factory_login";
export const cookieOpts = (c: Context) => ({ httpOnly: true, sameSite: "Lax" as const, secure: isHttps(c), path: "/" });

export const authRoutes = new Hono<Env>();

/** Who am I, and how can one sign in here. */
authRoutes.get("/session", async (c) => {
  const a = c.get("auth");
  const s = await settings();
  const rank = { pending: 0, viewer: 1, member: 2, admin: 3 } as const;
  return c.json({
    ok: Boolean(a && a.user.role !== "pending"),
    user: a ? { id: a.user.id, email: a.user.email, name: a.user.name, picture: a.user.picture, role: a.user.role, canApprove: rank[a.user.role] >= rank[s.approverRole] } : null,
    approverRole: s.approverRole,
    methods: { google: googleConfigured(), dev: DEV_LOGIN && !proxied(c) },
    proxied: proxied(c),
  });
});

const loginRedirect = (c: Context) => `${publicOrigin(c)}/api/auth/google/callback`;
const backToLogin = (c: Context, reason: string) => c.redirect(`/?login=${encodeURIComponent(reason)}`);

authRoutes.get("/auth/google", async (c) => {
  if (!googleConfigured()) return backToLogin(c, "error:Google sign-in is not configured on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  const st = newLoginState();
  setCookie(c, LOGIN_COOKIE, packLoginState(st), { httpOnly: true, sameSite: "Lax", secure: isHttps(c), path: "/api/auth", maxAge: 600 });
  return c.redirect(loginUrl(loginRedirect(c), st));
});

authRoutes.get("/auth/google/callback", async (c) => {
  const { code, state, error } = c.req.query();
  const st = unpackLoginState(getCookie(c, LOGIN_COOKIE));
  deleteCookie(c, LOGIN_COOKIE, { path: "/api/auth" });
  if (!googleConfigured()) return backToLogin(c, "error:Google sign-in is not configured on the server.");
  if (error) return backToLogin(c, error === "access_denied" ? "cancelled" : `error:${error}`);
  if (!code || !state || !st || state !== st.state) return backToLogin(c, "error:The sign-in did not start in this browser. Try again.");
  const ip = clientIp(c);
  const wait = lockedFor(ip);
  if (wait) return backToLogin(c, `error:Too many tries. Wait ${wait} minutes.`);
  try {
    const claims = await exchangeCode(code, loginRedirect(c), st);
    const user = await upsertUser(claims);
    if (user.disabled_at) { recordFailure(ip); return backToLogin(c, `denied:${user.email}`); }
    recordSuccess(ip);
    const token = await createSession(c, user.id);
    setCookie(c, SESSION_COOKIE, token, { ...cookieOpts(c), maxAge: 60 * 60 * 24 * SESSION_DAYS });
    await audit(user.id, "login", "google", { ip });
    return c.redirect("/");
  } catch (e) {
    if (e instanceof AuthError) { recordFailure(ip); return backToLogin(c, `error:${e.message}`); }
    console.error(e);
    return backToLogin(c, "error:Signing in failed on the server. Check the log.");
  }
});

/** Local development only: sign in as any address without Google. Never through the proxy. */
authRoutes.post("/auth/dev", async (c) => {
  if (!DEV_LOGIN || proxied(c)) throw new HttpError(404, "not found");
  const b = await body(c, z.object({ email: z.string().email(), name: z.string().max(100).optional() }));
  const user = await upsertUser({ email: b.email, name: b.name });
  const token = await createSession(c, user.id);
  setCookie(c, SESSION_COOKIE, token, { ...cookieOpts(c), maxAge: 60 * 60 * 24 * SESSION_DAYS });
  await audit(user.id, "login", "dev");
  return c.json({ ok: true, role: user.role });
});

authRoutes.post("/logout", async (c) => {
  const a = c.get("auth");
  if (a?.session) await revokeSession(a.session.id);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// --- behind the gate: my devices and tokens --------------------------------------

export const meRoutes = new Hono<Env>();
const me = (c: Context) => { const a = c.get("auth") as Auth | null; if (!a) throw new HttpError(401, "login required"); return a; };

meRoutes.get("/me/sessions", async (c) => {
  const a = me(c);
  return c.json((await listSessions(a.user.id)).map((s) => ({ id: s.id, device: describeAgent(s.user_agent), ip: s.ip, created_at: s.created_at, last_seen_at: s.last_seen_at, expires_at: s.expires_at, current: s.id === a.session?.id })));
});
meRoutes.delete("/me/sessions/others", async (c) => { const a = me(c); return c.json({ revoked: await revokeOthers(a.user.id, a.session?.id ?? null) }); });
meRoutes.delete("/me/sessions/:id", async (c) => {
  const a = me(c);
  const id = idParam(c);
  if (id === a.session?.id) throw new HttpError(400, "Use Log out for this device.");
  const own = (await listSessions(a.user.id)).some((s) => s.id === id);
  if (!own) throw new HttpError(404, "not found");
  await revokeSession(id);
  return c.json({ ok: true });
});
meRoutes.get("/me/tokens", async (c) => c.json(await listApiTokens(me(c).user.id)));
meRoutes.post("/me/tokens", async (c) => {
  const a = me(c);
  const b = await body(c, z.object({ name: z.string().min(1).max(80) }));
  const t = await createApiToken(a.user.id, b.name);
  await audit(a.user.id, "token.create", String(t.id));
  return c.json(t);
});
meRoutes.delete("/me/tokens/:id", async (c) => { const a = me(c); await revokeApiToken(a.user.id, idParam(c)); return c.json({ ok: true }); });
