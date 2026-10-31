import { Hono } from "hono";
import { z } from "zod";
import { q, one } from "../db.ts";
import { atLeast, type Auth } from "../lib/auth.ts";
import { HttpError, body } from "../lib/http.ts";
import { metrics, spentToday } from "../lib/metrics.ts";
import { saveSettings, settings } from "../lib/settings.ts";
import { listRunners } from "../lib/runners/index.ts";
import { activeRuns, throttled, usage } from "../lib/pipeline.ts";
import { notifierStatus } from "../lib/notifier.ts";
import { encryptionConfigured } from "../lib/crypto.ts";
import { googleConfigured } from "../lib/auth.ts";
import { emit } from "../lib/events.ts";
import type { Env } from "./auth.ts";

export const miscRoutes = new Hono<Env>();
const who = (c: { get: (k: "auth") => Auth | null }) => { const a = c.get("auth"); if (!a) throw new HttpError(401, "login required"); return a; };
const admin = (a: Auth) => { if (!atLeast(a.user, "admin")) throw new HttpError(403, "admins only"); return a; };

miscRoutes.get("/metrics", async (c) => c.json(await metrics(Number(c.req.query("days") || 30))));

miscRoutes.get("/settings", async (c) => {
  who(c);
  const s = await settings();
  const checks = await Promise.all(listRunners().map(async (r) => ({ id: r.id, label: r.label, capabilities: r.capabilities, ...(await r.check()) })));
  return c.json({ settings: s, spend: { today: await spentToday(), dailyBudgetUsd: s.dailyBudgetUsd }, runners: checks, usage, held: throttled(process.env.RUNNER || "claude", s.usageThreshold), notifier: await notifierStatus(), encryption: encryptionConfigured(), google: googleConfigured(), defaultRunner: process.env.RUNNER || "claude", model: process.env.CLAUDE_MODEL || "claude-opus-5-5", smallModel: process.env.CLAUDE_SMALL_MODEL || "claude-sonnet-5-5", dataDir: process.env.FACTORY_DATA || "./data" });
});

miscRoutes.put("/settings", async (c) => {
  const a = admin(who(c));
  const b = await body(c, z.object({ paused: z.boolean().optional(), maxConcurrentRuns: z.number().int().min(1).max(20).optional(), approverRole: z.enum(["member", "admin"]).optional(), keepWorktreeDays: z.number().int().min(0).max(90).optional(), newAccountRole: z.enum(["pending", "viewer"]).optional(), usageThreshold: z.number().min(0.1).max(1).optional(), dailyBudgetUsd: z.number().min(0).max(10000).optional(), digestHour: z.number().int().min(-1).max(23).optional() }));
  const before = await settings();
  const s = await saveSettings(b);
  if (b.paused !== undefined && b.paused !== before.paused) await emit({ type: "system", level: b.paused ? "warn" : "info", message: b.paused ? `the factory was paused by ${a.user.email}: nothing new starts until it is resumed` : `the factory was resumed by ${a.user.email}`, actor: a.user.email });
  return c.json(s);
});

/** One screen of truth for the CLI and chat commands. */
miscRoutes.get("/status", async (c) => {
  const s = await settings();
  const counts = await q<{ status: string; n: number }>("select status, count(*)::int as n from work_items where status not in ('done','failed','cancelled') group by status order by n desc");
  const today = await one<{ done: number; created: number }>("select count(*) filter (where status = 'done' and finished_at > now() - interval '24 hours')::int as done, count(*) filter (where created_at > now() - interval '24 hours')::int as created from work_items");
  const waiting = await q<{ id: number; title: string; status: string; gate: string | null; updated_at: string }>("select id, title, status, gate, updated_at from work_items where status in ('awaiting_approval', 'needs_info', 'blocked', 'review') order by updated_at limit 20");
  return c.json({ paused: s.paused, held: throttled(process.env.RUNNER || "claude", s.usageThreshold), active: activeRuns(), counts, today, waiting, usage, spend: { today: await spentToday(), dailyBudgetUsd: s.dailyBudgetUsd } });
});
