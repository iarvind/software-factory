// Who may open the factory, and how a signed-in device is remembered.
//
// Sign-in is Google (OpenID Connect code flow with PKCE and a nonce; the ID token's signature is
// checked against Google's JWKS). An account's role comes from .env on first sign-in:
// ADMIN_EMAILS are admins, ALLOWED_EMAILS / ALLOWED_DOMAINS are members, everyone else is
// "pending" until an admin lets them in. With no ADMIN_EMAILS, the first account is the admin.
// A session is a row in `sessions` and a random token in the factory_session cookie (only its
// sha256 is stored). Scripts and CI use API tokens (`Authorization: Bearer ft_…`).
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { q, one } from "../db.ts";
import { settings } from "./settings.ts";
import { pendingSignIn } from "./alerts.ts";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const list = (v: string | undefined) => (v || "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
export const ADMIN_EMAILS = list(process.env.ADMIN_EMAILS);
export const ALLOWED_EMAILS = list(process.env.ALLOWED_EMAILS);
export const ALLOWED_DOMAINS = list(process.env.ALLOWED_DOMAINS).map((d) => d.replace(/^@/, ""));
export const DEV_LOGIN = process.env.DEV_LOGIN === "1" || process.env.DEV_LOGIN === "true";
const APP_ORIGIN = (process.env.APP_ORIGIN || "").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 8282);

export const SESSION_COOKIE = "factory_session";
export const SESSION_DAYS = 90;

export const googleConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET);
export const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const proxied = (c: Context) => Boolean(c.req.header("x-forwarded-proto"));
export const isHttps = (c: Context) => c.req.header("x-forwarded-proto") === "https";
export const clientIp = (c: Context) => c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? getConnInfo(c).remote.address ?? "local";

/** The origin a browser used to reach us: APP_ORIGIN when pinned, else the proxy's headers. */
export function publicOrigin(c: Context): string {
  if (APP_ORIGIN) return APP_ORIGIN;
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}
export const appLink = () => (process.env.APP_LINK || APP_ORIGIN || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");

// --- users -------------------------------------------------------------------

export type Role = "admin" | "member" | "viewer" | "pending";
export type User = { id: number; email: string; name: string | null; picture: string | null; role: Role; created_at: string; last_seen_at: string | null; disabled_at: string | null };

export const ROLE_RANK: Record<Role, number> = { pending: 0, viewer: 1, member: 2, admin: 3 };
export const atLeast = (u: User | null | undefined, role: Role) => Boolean(u && !u.disabled_at && ROLE_RANK[u.role] >= ROLE_RANK[role]);

/** The role a fresh account gets, from .env; the very first account is the admin when no admins are named. */
export async function initialRole(email: string): Promise<Role> {
  const e = email.toLowerCase();
  const domain = e.split("@")[1] ?? "";
  if (ADMIN_EMAILS.includes(e)) return "admin";
  if (!ADMIN_EMAILS.length) {
    const n = await one<{ n: number }>("select count(*)::int as n from users");
    if (!n || n.n === 0) return "admin";
  }
  if (ALLOWED_EMAILS.includes(e) || ALLOWED_DOMAINS.includes(domain)) return "member";
  return (await settings()).newAccountRole;
}

export async function upsertUser(claims: { email: string; name?: string; picture?: string }): Promise<User> {
  const email = claims.email.toLowerCase();
  const existing = await one<User>("select * from users where email = $1", [email]);
  if (existing) {
    // An address promoted to admin in .env is promoted here too; nothing is ever demoted automatically.
    const role: Role = ADMIN_EMAILS.includes(email) ? "admin" : existing.role;
    return (await one<User>("update users set name = coalesce($2, name), picture = coalesce($3, picture), role = $4, last_seen_at = now() where id = $1 returning *", [existing.id, claims.name ?? null, claims.picture ?? null, role]))!;
  }
  const role = await initialRole(email);
  const user = (await one<User>("insert into users (email, name, picture, role, last_seen_at) values ($1, $2, $3, $4, now()) returning *", [email, claims.name ?? null, claims.picture ?? null, role]))!;
  // Only on the first sign-in: a pending account signing in again is not news.
  if (user.role === "pending") await pendingSignIn(user, appLink()).catch((e) => console.warn("pending sign-in alert failed", e));
  return user;
}

export const listUsers = () => q<User>("select * from users order by (role = 'pending') desc, created_at");
export const getUser = (id: number) => one<User>("select * from users where id = $1", [id]);

// --- sessions ----------------------------------------------------------------

export type Session = { id: number; user_id: number; user_agent: string | null; ip: string | null; created_at: string; last_seen_at: string; expires_at: string };
export type Auth = { user: User; session: Session | null; via: "cookie" | "token" };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

const cache = new Map<string, { a: Auth; until: number }>();
const CACHE_MS = 20 * 1000;
const TOUCH_MS = 5 * 60 * 1000;
export const dropAuthCache = () => cache.clear();

export async function createSession(c: Context, userId: number): Promise<string> {
  const token = b64url(randomBytes(32));
  const ua = (c.req.header("user-agent") ?? "").slice(0, 400) || null;
  await q("insert into sessions (token_hash, user_id, user_agent, ip, expires_at) values ($1, $2, $3, $4, now() + ($5 || ' days')::interval)", [hash(token), userId, ua, clientIp(c), String(SESSION_DAYS)]);
  return token;
}

export async function authFor(cookieToken: string | undefined, bearer: string | undefined): Promise<Auth | null> {
  if (bearer && bearer.startsWith("ft_")) return tokenAuth(bearer);
  const token = cookieToken;
  if (!token || token.length < 32 || token.length > 128) return null;
  const h = hash(token);
  const hit = cache.get(h);
  if (hit && hit.until > Date.now()) return hit.a;
  const s = await one<Session & { email: string; name: string | null; picture: string | null; role: Role; ucreated: string; ulast: string | null; disabled_at: string | null }>(
    `select s.id, s.user_id, s.user_agent, s.ip, s.created_at, s.last_seen_at, s.expires_at,
            u.email, u.name, u.picture, u.role, u.created_at as ucreated, u.last_seen_at as ulast, u.disabled_at
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`, [h]);
  if (!s || s.disabled_at) { cache.delete(h); return null; }
  if (Date.now() - new Date(s.last_seen_at).getTime() > TOUCH_MS) {
    await q("update sessions set last_seen_at = now() where id = $1", [s.id]);
    await q("update users set last_seen_at = now() where id = $1", [s.user_id]);
  }
  const a: Auth = {
    via: "cookie",
    session: { id: s.id, user_id: s.user_id, user_agent: s.user_agent, ip: s.ip, created_at: s.created_at, last_seen_at: s.last_seen_at, expires_at: s.expires_at },
    user: { id: s.user_id, email: s.email, name: s.name, picture: s.picture, role: s.role, created_at: s.ucreated, last_seen_at: s.ulast, disabled_at: s.disabled_at },
  };
  cache.set(h, { a, until: Date.now() + CACHE_MS });
  return a;
}

async function tokenAuth(token: string): Promise<Auth | null> {
  const h = hash(token);
  const hit = cache.get(h);
  if (hit && hit.until > Date.now()) return hit.a;
  const r = await one<{ id: number; user_id: number }>("select id, user_id from api_tokens where token_hash = $1 and revoked_at is null", [h]);
  if (!r) return null;
  const user = await getUser(r.user_id);
  if (!user || user.disabled_at) return null;
  await q("update api_tokens set last_used_at = now() where id = $1", [r.id]);
  const a: Auth = { via: "token", session: null, user };
  cache.set(h, { a, until: Date.now() + CACHE_MS });
  return a;
}

export async function revokeSession(id: number): Promise<void> { await q("update sessions set revoked_at = now() where id = $1 and revoked_at is null", [id]); cache.clear(); }
export async function revokeOthers(userId: number, keep: number | null): Promise<number> {
  const r = await q<{ id: number }>("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and expires_at > now() and ($2::bigint is null or id <> $2) returning id", [userId, keep]);
  cache.clear();
  return r.length;
}
export const listSessions = (userId: number) => q<Session>("select id, user_id, user_agent, ip, created_at, last_seen_at, expires_at from sessions where user_id = $1 and revoked_at is null and expires_at > now() order by last_seen_at desc", [userId]);
export async function pruneSessions(): Promise<void> { await q("delete from sessions where revoked_at is not null or expires_at < now() - interval '30 days'"); }

// --- api tokens ---------------------------------------------------------------

export async function createApiToken(userId: number, name: string): Promise<{ id: number; token: string }> {
  const token = `ft_${b64url(randomBytes(30))}`;
  const r = await one<{ id: number }>("insert into api_tokens (user_id, name, token_hash, prefix) values ($1, $2, $3, $4) returning id", [userId, name.slice(0, 80), hash(token), token.slice(0, 10)]);
  return { id: r!.id, token };
}
export const listApiTokens = (userId: number) => q<{ id: number; name: string; prefix: string; created_at: string; last_used_at: string | null }>("select id, name, prefix, created_at, last_used_at from api_tokens where user_id = $1 and revoked_at is null order by created_at desc", [userId]);
export async function revokeApiToken(userId: number, id: number): Promise<void> { await q("update api_tokens set revoked_at = now() where id = $1 and user_id = $2", [id, userId]); cache.clear(); }

/** "Safari on iPhone", "Chrome on Mac": enough to recognise a device in a list. */
export function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|python|node|playwright/i.test(ua) ? "Script" : "Browser";
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  return device ? `${browser} on ${device}` : browser;
}

// --- login attempts (in memory; Cloudflare in front is the real rate limiter) ---

const attempts = new Map<string, { fails: number; until: number }>();
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000, GLOBAL_MAX = 30;
let globalFails: number[] = [];

export function lockedFor(ip: string): number {
  const a = attempts.get(ip);
  const now = Date.now();
  globalFails = globalFails.filter((t) => t > now - LOCK_MS);
  if (globalFails.length >= GLOBAL_MAX) return Math.ceil((globalFails[0] + LOCK_MS - now) / 60000);
  if (a && a.until > now) return Math.ceil((a.until - now) / 60000);
  return 0;
}
export function recordFailure(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  const fails = (a && a.until > now - LOCK_MS ? a.fails : 0) + 1;
  attempts.set(ip, { fails, until: fails >= MAX_FAILS ? now + LOCK_MS : now });
  globalFails.push(now);
  if (attempts.size > 10000) attempts.clear();
  return fails >= MAX_FAILS;
}
export function recordSuccess(ip: string): void { attempts.delete(ip); }

// --- sign in with Google (OpenID Connect) -------------------------------------

export class AuthError extends Error {}

export type LoginState = { state: string; nonce: string; verifier: string };

export function newLoginState(): LoginState {
  return { state: b64url(randomBytes(16)), nonce: b64url(randomBytes(16)), verifier: b64url(randomBytes(32)) };
}
export const packLoginState = (s: LoginState) => `${s.state}.${s.nonce}.${s.verifier}`;
export function unpackLoginState(v: string | undefined): LoginState | null {
  const parts = (v ?? "").split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]{16,64}$/.test(p))) return null;
  return { state: parts[0], nonce: parts[1], verifier: parts[2] };
}

export function loginUrl(redirectUri: string, s: LoginState): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", s.state);
  u.searchParams.set("nonce", s.nonce);
  u.searchParams.set("code_challenge", b64url(createHash("sha256").update(s.verifier).digest()));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string };
let jwks: { keys: Jwk[]; until: number } | null = null;
/** Tests only: pretend these are Google's current keys. */
export const _useKeys = (keys: Jwk[]) => { jwks = { keys, until: Date.now() + 60_000 }; };

async function googleKeys(force = false): Promise<Jwk[]> {
  if (!force && jwks && jwks.until > Date.now()) return jwks.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new AuthError(`Google's signing keys could not be fetched (${res.status}).`);
  const data = (await res.json()) as { keys: Jwk[] };
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  jwks = { keys: data.keys, until: Date.now() + Math.min(maxAge, 24 * 3600) * 1000 };
  return jwks.keys;
}

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export type IdClaims = { sub?: string; email: string; name?: string; picture?: string };

/** Verifies the ID token's RS256 signature and every claim that matters. */
export async function verifyIdClaims(token: string, nonce: string): Promise<IdClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("Google returned a malformed ID token.");
  const [h, p, s] = parts;
  let header: { alg?: string; kid?: string };
  let claims: { iss?: string; aud?: string; exp?: number; iat?: number; nonce?: string; email?: string; email_verified?: boolean; sub?: string; name?: string; picture?: string };
  try { header = JSON.parse(fromB64url(h).toString("utf8")); claims = JSON.parse(fromB64url(p).toString("utf8")); }
  catch { throw new AuthError("Google returned an unreadable ID token."); }
  if (header.alg !== "RS256" || !header.kid) throw new AuthError("Unexpected ID token algorithm.");
  let key = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!key) key = (await googleKeys(true)).find((k) => k.kid === header.kid);
  if (!key) throw new AuthError("The ID token was signed with a key Google does not publish.");
  const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" }), fromB64url(s));
  if (!ok) throw new AuthError("The ID token's signature does not check out.");
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new AuthError("The ID token was not issued by Google.");
  if (claims.aud !== CLIENT_ID) throw new AuthError("The ID token was issued for a different app.");
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new AuthError("The ID token has expired.");
  if (typeof claims.iat === "number" && claims.iat > now + 300) throw new AuthError("The ID token is from the future.");
  if (!claims.nonce || !same(claims.nonce, nonce)) throw new AuthError("The sign-in did not start in this browser.");
  if (!claims.email || claims.email_verified !== true) throw new AuthError("Google did not vouch for this account's email address.");
  return { sub: claims.sub, email: claims.email, name: claims.name, picture: claims.picture };
}

/** The callback's code for Google's tokens (with the server's PKCE verifier), then the ID token's verified claims. */
export async function exchangeCode(code: string, redirectUri: string, st: LoginState): Promise<IdClaims> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, code_verifier: st.verifier, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const data = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || data.error || !data.id_token) throw new AuthError(`Google refused the sign-in: ${data.error_description ?? data.error ?? res.status}`);
  return verifyIdClaims(data.id_token, st.nonce);
}

export async function audit(userId: number | null, action: string, target?: string, data?: unknown): Promise<void> {
  await q("insert into audit (user_id, action, target, data) values ($1, $2, $3, $4)", [userId, action, target ?? null, data === undefined ? null : JSON.stringify(data)]);
}
