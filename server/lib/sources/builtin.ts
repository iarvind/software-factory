// The sources that need no outside service: a schedule, a watch on a URL, and a webhook.
import { randomBytes } from "node:crypto";
import { registerSource, type SourceAdapter, type SourceContext } from "./index.ts";

/** A job on a timer: "every night, read the error log and fix what you can"; "every Monday, bump the dependencies". */
const schedule: SourceAdapter = {
  kind: "schedule",
  label: "Schedule",
  description: "Creates the same request on a timer or cron schedule — nightly clean-ups, weekly dependency bumps, a recurring report. Needs a cron expression or an interval. One open item at a time.",
  defaultIntervalSec: null,
  fields: [
    { key: "title", label: "Title", required: true, placeholder: "Nightly: fix anything the error log complains about" },
    { key: "body", label: "Request", kind: "textarea", required: true, help: "What the agent should do each time. Be specific about where to look and what done means." },
    { key: "priority", label: "Priority", kind: "number", default: 3 },
    { key: "labels", label: "Labels", placeholder: "chore, scheduled" },
  ],
  async poll(ctx) {
    const title = String(ctx.config.title ?? ctx.source.name);
    // Each run has its own external id (run:<minute>), so "the last run" is whichever of this source's items is still open.
    const still = await ctx.openItem();
    if (still) { ctx.log(`skipped: #${still.id} from an earlier run is still ${still.status}`); return; }
    const stamp = new Date().toISOString().slice(0, 16);
    const r = await ctx.createItem({
      title: `${title} (${stamp.replace("T", " ")})`, body: String(ctx.config.body ?? ""), priority: Number(ctx.config.priority ?? 3) || 3,
      labels: String(ctx.config.labels ?? "").split(",").map((s) => s.trim()).filter(Boolean), origin: { kind: "schedule", sourceId: ctx.source.id }, externalId: `run:${stamp}`, requesterName: `schedule: ${ctx.source.name}`,
    });
    if (r.created) ctx.log(`created #${r.item.id}`);
  },
  async test() { return { ok: true, detail: "a schedule needs nothing from outside" }; },
};

/** Reads a URL and raises a request when what it finds is wrong: a health check failing, a count over a threshold, a word in a log. */
const watch: SourceAdapter = {
  kind: "watch",
  label: "Watch a service",
  description: "Polls a URL (a health endpoint, a stats JSON, a log) and opens a request when a condition holds — a 5xx, a number over a threshold, a phrase in the body. Closes the loop from running software back to work.",
  defaultIntervalSec: 300,
  fields: [
    { key: "url", label: "URL", required: true, placeholder: "http://127.0.0.1:4100/api/healthz" },
    { key: "headers", label: "Headers", kind: "textarea", placeholder: "Authorization: Bearer …\nAccept: application/json", help: "One per line; values may be secrets (use the field below and reference it as $TOKEN)." },
    { key: "token", label: "Secret token", secret: true, help: "Available to the Headers field as $TOKEN." },
    { key: "condition", label: "Trigger when", kind: "select", options: ["status_not_2xx", "body_contains", "json_path_gt", "json_path_lt", "json_path_equals", "json_path_not_equals"], required: true, default: "status_not_2xx" },
    { key: "path", label: "JSON path", placeholder: "errors.last24h", help: "Dots for nesting (for the json_path conditions)." },
    { key: "value", label: "Value", placeholder: "10" },
    { key: "title", label: "Request title", required: true, placeholder: "The notifier's health check is failing" },
    { key: "body", label: "Request", kind: "textarea", required: true, help: "What to do when it triggers. The response that triggered it is attached." },
    { key: "priority", label: "Priority", kind: "number", default: 2 },
  ],
  async poll(ctx) {
    const url = String(ctx.config.url ?? "");
    if (!url) throw new Error("no URL configured");
    const headers: Record<string, string> = {};
    for (const line of String(ctx.config.headers ?? "").split("\n")) {
      const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
      if (m) headers[m[1].trim()] = m[2].replace(/\$TOKEN/g, ctx.secrets.token ?? "");
    }
    let status = 0, body = "";
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: "follow" });
      status = res.status; body = (await res.text()).slice(0, 200_000);
    } catch (e) { status = 0; body = e instanceof Error ? e.message : String(e); }
    const cond = String(ctx.config.condition ?? "status_not_2xx");
    let fired = false, reason = "";
    if (cond === "status_not_2xx") { fired = status < 200 || status >= 300; reason = `HTTP ${status || "unreachable"}`; }
    else if (cond === "body_contains") { fired = body.includes(String(ctx.config.value ?? "")); reason = `body contains "${ctx.config.value}"`; }
    else {
      let v: unknown;
      try { v = String(ctx.config.path ?? "").split(".").filter(Boolean).reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), JSON.parse(body)); } catch { v = undefined; }
      const want = String(ctx.config.value ?? "");
      const n = Number(v);
      if (cond === "json_path_gt") fired = Number.isFinite(n) && n > Number(want);
      else if (cond === "json_path_lt") fired = Number.isFinite(n) && n < Number(want);
      else if (cond === "json_path_equals") fired = String(v) === want;
      else if (cond === "json_path_not_equals") fired = String(v) !== want;
      reason = `${ctx.config.path} is ${JSON.stringify(v)} (${cond.replace("json_path_", "")} ${want})`;
    }
    const wasFiring = Boolean(ctx.source.state?.firing);
    await ctx.saveState({ firing: fired, lastStatus: status, lastReason: reason, checkedAt: new Date().toISOString() });
    if (!fired) { if (wasFiring) ctx.log(`recovered: ${reason}`); return; }
    if (await ctx.openItem()) return; // one at a time: the open one already says what is wrong
    const r = await ctx.createItem({
      title: String(ctx.config.title ?? ctx.source.name), priority: Number(ctx.config.priority ?? 2) || 2,
      body: `${ctx.config.body ?? ""}\n\n---\nTriggered by the watch on ${url}: ${reason} at ${new Date().toISOString()}.\n\nResponse (first 4000 characters):\n\`\`\`\n${body.slice(0, 4000)}\n\`\`\``,
      origin: { kind: "watch", sourceId: ctx.source.id }, externalId: `fired:${new Date().toISOString()}`, requesterName: `watch: ${ctx.source.name}`, labels: ["alert"],
    });
    if (r.created) ctx.log(`fired (${reason}) → #${r.item.id}`, "warn");
  },
  async test(ctx) {
    const url = String(ctx.config.url ?? "");
    try { const res = await fetch(url, { signal: AbortSignal.timeout(10000) }); return { ok: true, detail: `HTTP ${res.status} from ${url}` }; }
    catch (e) { return { ok: false, detail: `${url}: ${e instanceof Error ? e.message : String(e)}` }; }
  },
};

/** Anything that can POST JSON: a CI job, a monitoring tool, a form, another app on this Mac. */
const webhook: SourceAdapter = {
  kind: "webhook",
  label: "Webhook",
  description: "An HTTP endpoint other systems POST to: {title, body, externalId?, url?, priority?, labels?, requester?}. Each source gets its own secret URL.",
  defaultIntervalSec: null,
  fields: [
    { key: "hookToken", label: "Hook token", help: "Generated when saved; the endpoint is /api/hooks/<token>. Leave as is." },
    { key: "labels", label: "Labels", placeholder: "webhook" },
  ],
  async webhook(ctx, body) {
    const b = (body ?? {}) as Record<string, unknown>;
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title) return { status: 400, body: { error: "title is required" } };
    const r = await ctx.createItem({
      title, body: typeof b.body === "string" ? b.body : JSON.stringify(b, null, 2), externalId: typeof b.externalId === "string" ? b.externalId : null, externalUrl: typeof b.url === "string" ? b.url : null,
      priority: typeof b.priority === "number" ? b.priority : 3, labels: [...String(ctx.config.labels ?? "").split(",").map((s) => s.trim()).filter(Boolean), ...(Array.isArray(b.labels) ? b.labels.map(String) : [])],
      requesterName: typeof b.requester === "string" ? b.requester : `webhook: ${ctx.source.name}`, origin: { kind: "webhook", sourceId: ctx.source.id },
    });
    return { status: r.created ? 201 : 200, body: { id: r.item.id, created: r.created, status: r.item.status } };
  },
  async test() { return { ok: true, detail: "POST JSON to the hook URL to try it" }; },
};

export function registerBuiltinSources(): void {
  registerSource(schedule);
  registerSource(watch);
  registerSource(webhook);
}

export const newHookToken = () => randomBytes(18).toString("base64url");
export type { SourceContext };
