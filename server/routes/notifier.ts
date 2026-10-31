// What comes back from Telegram through the notifier: button presses on approvals and
// reviews, and the /factory, /approvals and /build commands.
import { Hono } from "hono";
import { q } from "../db.ts";
import { proxied, same } from "../lib/auth.ts";
import { hookSecret } from "../lib/notifier.ts";
import { createItem, listPendingApprovals, mustItem } from "../lib/items.ts";
import { decide, reviewDecision, activeRuns } from "../lib/pipeline.ts";
import { projectBySlug, listProjects } from "../lib/projects.ts";
import { itemLink } from "../lib/conversations.ts";

type HookIn = { type: "action" | "command" | "message"; data?: string | null; command?: string | null; args?: string | null; text?: string | null; from?: { id: number; name?: string; username?: string }; notificationId?: string };

export const notifierRoutes = new Hono();

notifierRoutes.post("/notifier/hook", async (c) => {
  if (proxied(c) || c.req.header("x-forwarded-for") || c.req.header("x-real-ip")) return c.json({ error: "not found" }, 404);
  if (!same(c.req.header("authorization") ?? "", `Bearer ${await hookSecret()}`)) return c.json({ error: "bad secret" }, 401);
  const b = (await c.req.json().catch(() => null)) as HookIn | null;
  if (!b || typeof b.type !== "string") return c.json({ error: "body must be the notifier's hook payload" }, 400);
  const who = { via: "telegram", name: b.from?.name || b.from?.username || "telegram" };
  // A Telegram group can hold more people than the approvers: TELEGRAM_APPROVER_IDS names who may decide and ask for work.
  const allowed = (process.env.TELEGRAM_APPROVER_IDS || "").split(/[\s,]+/).filter(Boolean);
  if (allowed.length && (b.type === "action" || b.command === "build") && !allowed.includes(String(b.from?.id ?? ""))) return c.json({ toast: `${who.name} is not on the factory's Telegram approvers list.`, alert: true });
  try {
    if (b.type === "action" && b.data) {
      const [verb, idStr] = b.data.split(":");
      const id = Number(idStr);
      if ((verb === "approve" || verb === "reject") && id) {
        const a = await decide(id, verb === "approve" ? "approved" : "rejected", who);
        const it = await mustItem(a.item_id);
        return c.json({ toast: `${a.kind} ${verb === "approve" ? "approved" : "declined"}`, update: { title: `#${it.id} ${it.title}`, description: `${a.kind} ${verb === "approve" ? "approved" : "declined"} by ${who.name}. Now: ${it.status.replace("_", " ")}.`, compact: true, buttons: [[{ text: "Open", url: itemLink(it.id) }]] } });
      }
      if (verb === "review-approve" && id) {
        await reviewDecision(id, "approved", "approved from Telegram", who);
        const it = await mustItem(id);
        return c.json({ toast: "approved", update: { title: `#${it.id} ${it.title}`, description: `Approved by ${who.name}. Now: ${it.status.replace("_", " ")}.`, compact: true, buttons: [[{ text: "Open", url: itemLink(it.id) }]] } });
      }
      return c.json({ toast: "I do not know that button any more." });
    }
    if (b.type === "command") {
      if (b.command === "factory") {
        const counts = await q<{ status: string; n: number }>("select status, count(*)::int as n from work_items where status not in ('done','failed','cancelled') group by status order by n desc");
        const active = activeRuns();
        const lines = counts.map((x) => `${x.status.replace("_", " ")}: ${x.n}`);
        return c.json({ reply: { title: "The factory", description: `${active.length} run(s) going${active.length ? ` (${active.map((a) => `#${a.itemId} ${a.kind}`).join(", ")})` : ""}.\n${lines.join("\n") || "Nothing open."}`, compact: true, buttons: [[{ text: "Open", url: itemLink(0).replace(/\/items\/0$/, "") }]] } });
      }
      if (b.command === "approvals") {
        const pend = await listPendingApprovals();
        if (!pend.length) return c.json({ reply: { description: "Nothing is waiting for a decision.", compact: true } });
        return c.json({ reply: { title: "Waiting for a decision", description: pend.map((a) => `#${a.item_id} ${a.title}: ${a.kind}`).join("\n"), compact: true, buttons: pend.slice(0, 6).map((a) => [{ text: `✓ #${a.item_id}`, data: `approve:${a.id}` }, { text: `✕ #${a.item_id}`, data: `reject:${a.id}` }]) } });
      }
      if (b.command === "build") {
        const m = /^(\S+)\s+([\s\S]+)$/.exec((b.args ?? "").trim());
        if (!m) return c.json({ reply: { description: `Say which project and what you want: /build <project> <request>\nProjects: ${(await listProjects()).map((p) => p.slug).join(", ") || "none yet"}`, compact: true } });
        const p = await projectBySlug(m[1]);
        if (!p) return c.json({ reply: { description: `No project "${m[1]}". Projects: ${(await listProjects()).map((x) => x.slug).join(", ")}`, compact: true } });
        const r = await createItem({ title: m[2].split("\n")[0].slice(0, 200), body: m[2], projectId: p.id, origin: { kind: "telegram", user: String(b.from?.id ?? "") }, requesterName: who.name }, who.name);
        return c.json({ reply: { description: `Taken: #${r.item.id} "${r.item.title}" for ${p.name}.`, compact: true, buttons: [[{ text: "Open", url: itemLink(r.item.id) }]] } });
      }
    }
    return c.json({});
  } catch (e) {
    return c.json({ toast: (e instanceof Error ? e.message : String(e)).slice(0, 200), alert: true });
  }
});
