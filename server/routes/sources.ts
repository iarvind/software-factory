import { Hono } from "hono";
import { z } from "zod";
import { atLeast, audit, type Auth } from "../lib/auth.ts";
import { HttpError, body, idParam } from "../lib/http.ts";
import { contextFor, createSource, deleteSource, getAdapter, getSource, listAdapters, listSources, pollSource, publicSource, sourceByToken, updateSource } from "../lib/sources/index.ts";
import { newHookToken } from "../lib/sources/builtin.ts";
import { encryptionConfigured } from "../lib/crypto.ts";
import type { Env } from "./auth.ts";

export const sourceRoutes = new Hono<Env>();
const who = (c: { get: (k: "auth") => Auth | null }) => { const a = c.get("auth"); if (!a) throw new HttpError(401, "login required"); return a; };
const member = (a: Auth) => { if (!atLeast(a.user, "member")) throw new HttpError(403, "members only"); return a; };
const admin = (a: Auth) => { if (!atLeast(a.user, "admin")) throw new HttpError(403, "admins only"); return a; };

sourceRoutes.get("/sources/kinds", (c) => c.json({ kinds: listAdapters(), encryption: encryptionConfigured() }));
sourceRoutes.get("/sources", async (c) => {
  const a = c.get("auth");
  const list = (await listSources()).map(publicSource);
  // A hook token is the whole secret of a webhook source: members see it, viewers do not.
  if (!atLeast(a?.user, "member")) for (const s of list) if (s.config && typeof s.config === "object") delete (s.config as Record<string, unknown>).hookToken;
  return c.json(list);
});

const SourceIn = z.object({
  kind: z.string().max(40), name: z.string().min(1).max(100), projectId: z.number().int().positive().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(), secrets: z.record(z.string(), z.string()).optional(),
  intervalSec: z.number().int().min(15).max(86400 * 7).nullable().optional(), cron: z.string().max(100).nullable().optional(), enabled: z.boolean().optional(),
});

sourceRoutes.post("/sources", async (c) => {
  const a = admin(who(c));
  const b = await body(c, SourceIn);
  const ad = getAdapter(b.kind);
  if (!ad) throw new HttpError(400, `unknown source kind ${b.kind}`);
  const secrets = b.secrets ?? {};
  if (Object.keys(secrets).length && !encryptionConfigured()) throw new HttpError(400, "FACTORY_SECRET is not set in .env, so secrets cannot be stored");
  for (const f of ad.fields) {
    const missing = f.secret ? !secrets[f.key] : b.config?.[f.key] == null || b.config[f.key] === "";
    if (f.required && missing) throw new HttpError(400, `${f.label} is required`);
  }
  const config = { ...(b.config ?? {}) };
  if (ad.webhook && !config.hookToken) config.hookToken = newHookToken();
  try {
    const s = await createSource({ kind: b.kind, name: b.name, projectId: b.projectId ?? null, config, secrets, intervalSec: b.intervalSec ?? (ad.defaultIntervalSec ?? null), cron: b.cron ?? null, enabled: b.enabled, createdBy: a.user.id });
    await audit(a.user.id, "source.create", `${b.kind}:${b.name}`);
    return c.json(publicSource(s), 201);
  } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
});

sourceRoutes.patch("/sources/:id", async (c) => {
  const a = admin(who(c));
  const id = idParam(c);
  const b = await body(c, SourceIn.partial().omit({ kind: true }));
  if (b.secrets && Object.values(b.secrets).some((v) => v) && !encryptionConfigured()) throw new HttpError(400, "FACTORY_SECRET is not set in .env, so secrets cannot be stored");
  try {
    const s = await updateSource(id, { name: b.name, ...("projectId" in b ? { projectId: b.projectId ?? null } : {}), config: b.config, secrets: b.secrets, ...("intervalSec" in b ? { intervalSec: b.intervalSec ?? null } : {}), ...("cron" in b ? { cron: b.cron ?? null } : {}), enabled: b.enabled });
    await audit(a.user.id, "source.update", `${s.kind}:${s.name}`, Object.keys(b));
    return c.json(publicSource(s));
  } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
});

sourceRoutes.delete("/sources/:id", async (c) => {
  const a = admin(who(c));
  const s = await getSource(idParam(c));
  if (!s) throw new HttpError(404, "no such source");
  await deleteSource(s.id);
  await audit(a.user.id, "source.delete", `${s.kind}:${s.name}`);
  return c.json({ ok: true });
});

sourceRoutes.post("/sources/:id/test", async (c) => {
  member(who(c));
  const s = await getSource(idParam(c));
  if (!s) throw new HttpError(404, "no such source");
  const ad = getAdapter(s.kind);
  if (!ad?.test) return c.json({ ok: true, detail: "nothing to test for this kind" });
  try { return c.json(await ad.test(contextFor(s))); } catch (e) { return c.json({ ok: false, detail: e instanceof Error ? e.message : String(e) }); }
});

sourceRoutes.post("/sources/:id/poll", async (c) => {
  member(who(c));
  const s = await getSource(idParam(c));
  if (!s) throw new HttpError(404, "no such source");
  await pollSource(s, true);
  const after = await getSource(s.id);
  return c.json({ ok: !after?.last_error, error: after?.last_error ?? null, last_polled_at: after?.last_polled_at });
});

/** Inbound webhooks, addressed by the source's own token. No session; the token is the secret. */
export const hookRoutes = new Hono();
hookRoutes.all("/hooks/:token", async (c) => {
  const s = await sourceByToken(c.req.param("token"));
  if (!s) return c.json({ error: "not found" }, 404);
  const ad = getAdapter(s.kind);
  if (!ad?.webhook) return c.json({ error: "this source does not take webhooks" }, 404);
  let payload: unknown = null;
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("json")) payload = await c.req.json().catch(() => null);
  else if (ct.includes("form")) payload = Object.fromEntries((await c.req.formData()).entries());
  else payload = await c.req.text().catch(() => null);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  try {
    const r = await ad.webhook(contextFor(s), payload, headers);
    return c.json(r.body as object, r.status as 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
