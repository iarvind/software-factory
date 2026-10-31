import { Hono } from "hono";
import { z } from "zod";
import { q } from "../db.ts";
import { atLeast, audit, dropAuthCache, getUser, listUsers, type Auth } from "../lib/auth.ts";
import { HttpError, body, idParam } from "../lib/http.ts";
import type { Env } from "./auth.ts";

export const userRoutes = new Hono<Env>();
const admin = (a: Auth | null) => { if (!a || !atLeast(a.user, "admin")) throw new HttpError(403, "admins only"); return a; };

userRoutes.get("/users", async (c) => {
  const a = c.get("auth");
  const users = await listUsers();
  const stats = await q<{ requester_id: number; n: number }>("select requester_id, count(*)::int as n from work_items where requester_id is not null group by requester_id");
  const by = new Map(stats.map((s) => [s.requester_id, s.n]));
  return c.json(users.map((u) => ({ id: u.id, email: u.email, name: u.name, picture: u.picture, role: u.role, created_at: u.created_at, last_seen_at: u.last_seen_at, disabled: Boolean(u.disabled_at), items: by.get(u.id) ?? 0, me: u.id === a?.user.id })));
});

userRoutes.patch("/users/:id", async (c) => {
  const a = admin(c.get("auth"));
  const id = idParam(c);
  const b = await body(c, z.object({ role: z.enum(["admin", "member", "viewer", "pending"]).optional(), disabled: z.boolean().optional() }));
  const u = await getUser(id);
  if (!u) throw new HttpError(404, "no such user");
  if (u.id === a.user.id && (b.role && b.role !== "admin" || b.disabled)) throw new HttpError(400, "you cannot demote or disable yourself");
  if (b.role) await q("update users set role = $2 where id = $1", [id, b.role]);
  if (b.disabled !== undefined) await q(`update users set disabled_at = ${b.disabled ? "now()" : "null"} where id = $1`, [id]);
  if (b.disabled) await q("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [id]);
  dropAuthCache();
  await audit(a.user.id, "user.update", u.email, b);
  return c.json(await getUser(id));
});

userRoutes.delete("/users/:id", async (c) => {
  const a = admin(c.get("auth"));
  const id = idParam(c);
  if (id === a.user.id) throw new HttpError(400, "you cannot remove yourself");
  const u = await getUser(id);
  if (!u) throw new HttpError(404, "no such user");
  await q("delete from users where id = $1", [id]);
  dropAuthCache();
  await audit(a.user.id, "user.delete", u.email);
  return c.json({ ok: true });
});
