// Once a day, the factory tells the team how it went: what shipped, what is waiting on a
// person, what it cost. Telegram through the notifier; sources that can broadcast (a Slack
// status channel) get the same text.
import { q, one, kvGet, kvSet } from "../db.ts";
import { notify, notifierConfigured } from "./notifier.ts";
import { appLink } from "./auth.ts";
import { settings } from "./settings.ts";
import { emit } from "./events.ts";
import { broadcast } from "./sources/index.ts";

/** The calendar day where this machine is, so "once a day" means a local day. */
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function digestText(): Promise<{ title: string; text: string }> {
  const day = await one<{ shipped: number; arrived: number; failed: number; cost: number }>(
    `select count(*) filter (where status = 'done' and finished_at > now() - interval '24 hours')::int as shipped,
            count(*) filter (where created_at > now() - interval '24 hours')::int as arrived,
            count(*) filter (where status in ('failed', 'cancelled') and finished_at > now() - interval '24 hours')::int as failed,
            coalesce((select sum(cost_usd) from runs where finished_at > now() - interval '24 hours'), 0)::float as cost
       from work_items`);
  const shipped = await q<{ id: number; title: string; name: string | null }>("select w.id, w.title, p.name from work_items w left join projects p on p.id = w.project_id where w.status = 'done' and w.finished_at > now() - interval '24 hours' order by w.finished_at desc limit 12");
  const waiting = await q<{ id: number; title: string; status: string; gate: string | null; hours: number }>("select id, title, status, gate, extract(epoch from (now() - updated_at)) / 3600 as hours from work_items where status in ('awaiting_approval', 'review', 'needs_info', 'blocked') order by updated_at limit 12");
  const lines: string[] = [];
  lines.push(`Last 24 h: ${day?.arrived ?? 0} arrived, ${day?.shipped ?? 0} shipped${day?.failed ? `, ${day.failed} failed or cancelled` : ""}, $${(day?.cost ?? 0).toFixed(2)} API-equivalent${day?.shipped ? ` ($${((day.cost ?? 0) / day.shipped).toFixed(2)} per shipped change)` : ""}.`);
  if (shipped.length) lines.push("", "Shipped:", ...shipped.map((s) => `• #${s.id} ${s.title}${s.name ? ` (${s.name})` : ""}`));
  if (waiting.length) lines.push("", "Waiting on a person:", ...waiting.map((w) => `• #${w.id} ${w.title} — ${w.status === "awaiting_approval" ? `${w.gate} approval` : w.status.replace("_", " ")}, ${w.hours < 1 ? `${Math.round(w.hours * 60)} min` : `${Math.round(w.hours)} h`}`));
  else lines.push("", "Nothing is waiting on a person.");
  return { title: "Factory, the daily word", text: lines.join("\n") };
}

async function sendDigest(): Promise<void> {
  const d = await digestText();
  let sent = 0;
  if (notifierConfigured()) {
    try { await notify({ title: d.title, description: d.text, level: "info", compact: true, silent: true, link: appLink(), dedupeKey: `factory:digest:${localDay()}` }); sent++; } catch (e) { console.warn("digest to telegram:", e instanceof Error ? e.message : e); }
  }
  sent += await broadcast(`*${d.title}*\n${d.text}`).catch(() => 0);
  await emit({ type: "system", message: `daily digest sent to ${sent} place(s)`, data: { text: d.text } });
}

/** Fires once a day at the configured local hour (settings.digestHour; -1 is off), catching up after a restart. */
export function startDigest(): void {
  const check = async () => {
    const s = await settings();
    const hour = s.digestHour;
    if (hour == null || hour < 0) return;
    const now = new Date();
    if (now.getHours() < hour) return;
    const today = localDay(now);
    if ((await kvGet<string>("digest_last")) === today) return;
    await kvSet("digest_last", today);
    await sendDigest();
  };
  setTimeout(() => check().catch((e) => console.error("digest", e)), 30 * 1000).unref();
  setInterval(() => check().catch((e) => console.error("digest", e)), 5 * 60 * 1000).unref();
}
