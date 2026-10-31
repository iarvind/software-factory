// Shared plumbing for the sources that talk to an outside service (Slack, Jira, GitHub,
// Linear): a fetch that always times out and waits out rate limits, a few text helpers, and
// the one place where a comment saying "approve" becomes a decision.
import { pendingApproval, type Item } from "../items.ts";
import { decide, reviewDecision } from "../pipeline.ts";
import type { PostButtons, PostMessage } from "../conversations.ts";
import type { SourceContext } from "./index.ts";

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// --- HTTP ------------------------------------------------------------------------------

/** A failed call: the status (0 = never got an answer) and, when rate limited, how long to wait. */
export class FetchError extends Error {
  status: number;
  retryAfterMs: number | null;
  constructor(message: string, status: number, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** How long the server asked us to wait: Retry-After (seconds or a date), or the rate-limit reset when nothing is left. */
export function retryAfterMs(h: Headers, now = Date.now()): number | null {
  const ra = h.get("retry-after");
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - now);
  }
  if (h.get("x-ratelimit-remaining") === "0") {
    const reset = Number(h.get("x-ratelimit-reset"));
    // GitHub sends epoch seconds; some send epoch milliseconds.
    if (reset > 0) return Math.max(0, (reset > 1e12 ? reset : reset * 1000) - now);
  }
  return null;
}

export type FetchOptions = {
  method?: string; headers?: Record<string, string>; body?: string | URLSearchParams;
  /** Per attempt. */
  timeoutMs?: number;
  retries?: number;
  /** The longest Retry-After we sleep through; longer waits fail this call (the next poll tries again). */
  maxWaitMs?: number;
  /** Safe to repeat after a network error or a 502/503/504 (default: GET and HEAD). A 429 is always retried: nothing was done. */
  idempotent?: boolean;
  /** Names the call in errors, e.g. "jira GET /rest/api/3/myself". Never put secrets here. */
  label?: string;
  /** Non-2xx statuses the caller handles itself (304, 404). */
  accept?: number[];
};

const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);
const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

/** fetch with a timeout on every attempt and rate limits honoured. Throws FetchError carrying the status and the start of the body. */
export async function fetchRetry(url: string, o: FetchOptions = {}): Promise<Response> {
  const method = o.method ?? "GET";
  const label = o.label ?? `${method} ${new URL(url).host}${new URL(url).pathname}`;
  const idempotent = o.idempotent ?? (method === "GET" || method === "HEAD");
  const retries = o.retries ?? 3;
  const maxWait = o.maxWaitMs ?? 30_000;
  const timeoutMs = o.timeoutMs ?? 20_000;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method, headers: o.headers, body: o.body, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      const why = timedOut ? `no answer in ${Math.round(timeoutMs / 1000)} s` : e instanceof Error && e.cause instanceof Error ? e.cause.message : errText(e);
      if (idempotent && attempt < retries) { await sleep(jitter(backoff(attempt))); continue; }
      throw new FetchError(`${label}: ${why}`, 0);
    }
    if (res.ok || o.accept?.includes(res.status)) return res;
    const limited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
    const transient = res.status === 502 || res.status === 503 || res.status === 504;
    const wait = retryAfterMs(res.headers);
    if ((limited || (transient && idempotent)) && attempt < retries) {
      const ms = wait ?? backoff(attempt);
      if (ms <= maxWait) { await res.body?.cancel().catch(() => {}); await sleep(jitter(ms)); continue; }
    }
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim();
    throw new FetchError(`${label} → HTTP ${res.status}${limited ? ` (rate limited${wait != null ? `, retry in ${Math.ceil(wait / 1000)} s` : ""})` : ""}: ${text.slice(0, 300) || res.statusText}`, res.status, limited ? wait : null);
  }
}

/** The body as JSON, or a FetchError that shows what came back instead. Empty bodies are null. */
export async function readJson<T>(res: Response, label = "response"): Promise<T> {
  const text = await res.text();
  if (!text.trim()) return null as T;
  try { return JSON.parse(text) as T; } catch { throw new FetchError(`${label}: not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status); }
}

// --- config ----------------------------------------------------------------------------

/** A config string: undefined means "use the default", "" means "deliberately empty". */
export const cfgStr = (v: unknown, def = ""): string => (v == null ? def : String(v).trim());
export function cfgBool(v: unknown, def: boolean): boolean {
  if (v == null || v === "") return def;
  if (typeof v === "boolean") return v;
  return ["true", "1", "yes", "on"].includes(String(v).trim().toLowerCase());
}
/** "a, b\nc" → ["a", "b", "c"]. Commas and new lines only, so names with spaces ("In Progress") survive. */
export const cfgList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[,\n]+/)).map((s) => s.trim()).filter(Boolean);

// --- text ------------------------------------------------------------------------------

/** Lower case, no markup, single spaces: for recognising one-word replies. */
export const squash = (text: string) => text.replace(/[*_~`>]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

const APPROVE = new Set(["approve", "approved", "lgtm", "ship it"]);
const REJECT = new Set(["reject", "rejected", "decline", "declined"]);

/** A reply that is only a verdict ("approve", "LGTM", "/reject", "**approve**") → which one; anything longer is not a decision. */
export function isDecision(text: string): "approve" | "reject" | null {
  const w = squash(text).replace(/^\/+/, "").replace(/[.!\s]+$/, "");
  if (APPROVE.has(w)) return "approve";
  if (REJECT.has(w)) return "reject";
  return null;
}

/** "changes: rename the button" → "rename the button"; null when the reply is not a change request. */
export function changesRequested(text: string): string | null {
  const m = /^[\s*_]*\/?(?:changes(?: requested)?|request changes)[\s*_]*[:\-–—][\s*_]*([\s\S]*\S)/i.exec(text);
  return m ? m[1].trim() : null;
}

/** The factory's text (plain, a little markdown) → Slack mrkdwn: & < > escaped (so no <!channel>), **bold** → *bold*, [label](url) → <url|label>. "#123" stays plain. */
export function toMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `<${url}|${label}>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

/** The first non-empty line, shortened: a title for a request that arrived as free text. */
export function titleFrom(text: string, fallback: string, max = 120): string {
  const line = (text.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^#+\s*/, "");
  if (!line) return fallback;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

type DataButton = { text: string; data: string };
const dataButtons = (b: PostButtons | undefined) => (b ?? []).filter((x): x is DataButton => "data" in x);

/** Where a source has no buttons, the line that says what to reply instead. Empty when nothing is being asked. */
export function decisionHint(buttons: PostButtons | undefined, o: { md?: boolean; where?: string } = {}): string {
  const data = dataButtons(buttons);
  const verb = (b: DataButton) => b.data.split(":")[0];
  const w = (s: string) => (o.md ? `**${s}**` : `'${s}'`);
  const where = o.where ? ` ${o.where}` : "";
  const approve = data.find((b) => verb(b) === "approve");
  const reject = data.find((b) => verb(b) === "reject");
  if (data.some((b) => verb(b) === "review-approve")) return `Reply ${w("approve")}${where} to accept the change, or ${w("changes:")} followed by what to change.`;
  if (approve && reject) return `Reply ${w("approve")} (${approve.text}) or ${w("reject")} (${reject.text})${where}.`;
  if (approve) return `Reply ${w("approve")} (${approve.text})${where}.`;
  return "";
}

/** The link buttons as lines: "Open PR: https://…" or "[Open PR](https://…)". */
export function linkLines(buttons: PostButtons | undefined, md = false): string {
  return (buttons ?? []).filter((b): b is { text: string; url: string } => "url" in b).map((b) => (md ? `[${b.text}](${b.url})` : `${b.text}: ${b.url}`)).join(md ? " · " : "\n");
}

/** A status post as a markdown comment (GitHub, Linear). The marker, when given, lets the poller recognise its own comments. */
export function markdownComment(msg: PostMessage, o: { where?: string; marker?: string; link?: { id: number; url: string } } = {}): string {
  const icon = { success: "✅ ", warning: "⚠️ ", error: "❌ ", info: "" }[msg.level ?? "info"];
  // "#12" means the factory's item 12; on GitHub it would link to the repository's issue 12 instead.
  const text = o.link ? msg.text.replace(new RegExp(`(^|[^\\w[])#${o.link.id}\\b`, "g"), `$1[#${o.link.id}](${o.link.url})`) : msg.text;
  return [msg.title ? `**${msg.title}**` : "", `${icon}${text}`, decisionHint(msg.buttons, { md: true, where: o.where }), linkLines(msg.buttons, true), o.marker ?? ""].filter(Boolean).join("\n\n");
}

// --- serialising -----------------------------------------------------------------------

const chains = new Map<string, Promise<unknown>>();
/** Runs fn once any earlier call with the same key has finished: one intake per Slack thread at a time, so two events for one message cannot both create it. */
export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
}

// --- comments that decide ----------------------------------------------------------------

export type CommentOutcome = "approved" | "rejected" | "review-approved" | "changes-requested" | "feedback" | "ignored";

const ident = (x: string) => x.trim().toLowerCase().replace(/^@/, "");

/**
 * Whether a person is on the source's `approvers` list (empty: anyone who can write there). Pass
 * only identities their owner cannot rename at will: a member or account id, a login, an address.
 * Never a display name. Case and a leading @ do not matter.
 */
export function mayDecide(ctx: Pick<SourceContext, "config">, ...identities: Array<string | null | undefined>): boolean {
  const list = cfgList(ctx.config.approvers).map(ident).filter(Boolean);
  if (!list.length) return true;
  return identities.some((id) => id != null && ident(String(id)) !== "" && list.includes(ident(String(id))));
}

/** The external id for another request on the same ticket once the earlier one closed: `ref#2` after `ref`, `ref#3` after `ref#2`. */
export function nextExternalId(base: string, prior: string | null | undefined): string {
  const n = prior?.startsWith(`${base}#`) ? /^\d+$/.exec(prior.slice(base.length + 1))?.[0] : undefined;
  return `${base}#${n ? Number(n) + 1 : 2}`;
}

/**
 * A comment on an item's ticket or thread. "approve"/"reject" decides the pending approval, but
 * only if it was written after the approval was asked for, so an old comment read again cannot
 * pass a later gate. In review, "approve" accepts the change and "changes: …" asks for a fix.
 * Anything else is feedback (an answer, a note for the next run, or a fix round in review).
 * `identities` are what `mayDecide` matches; `author` is only for display.
 */
export async function handleDecisionComment(ctx: SourceContext, item: Item, text: string, author: string | null, externalId: string, opts: { createdAt?: string | Date | null; reply?: (text: string) => Promise<unknown>; identities?: Array<string | null | undefined> } = {}): Promise<CommentOutcome> {
  const who = { via: ctx.source.kind, name: author || ctx.source.kind };
  const verdict = isDecision(text);
  const changes = changesRequested(text);
  try {
    // Display names can be edited by their owners, so they never stand in for an id: with approvers listed and no ids, nobody decides.
    if ((verdict || changes) && !mayDecide(ctx, ...(opts.identities ?? []))) {
      await opts.reply?.(`${author ?? "You"} is not on this source's approvers list, so that does not decide anything; I kept it as a comment.`);
      await ctx.feedback(item.id, { author, body: text, externalId });
      return "feedback";
    }
    if (verdict) {
      const a = await pendingApproval(item.id);
      if (a) {
        const at = opts.createdAt ? new Date(opts.createdAt).getTime() : NaN;
        if (Number.isFinite(at) && at < new Date(a.requested_at).getTime()) {
          ctx.log(`#${item.id}: ignored "${verdict}" from ${who.name}: it was written before the ${a.kind} approval was asked for`);
          return "ignored";
        }
        await decide(a.id, verdict === "approve" ? "approved" : "rejected", who, `by a ${ctx.source.kind} comment`);
        ctx.log(`#${item.id}: ${a.kind} ${verdict === "approve" ? "approved" : "rejected"} by ${who.name}`);
        return verdict === "approve" ? "approved" : "rejected";
      }
      if (item.status === "review") {
        if (verdict === "approve") { await reviewDecision(item.id, "approved", text.trim(), { ...who, externalId }); return "review-approved"; }
        // A bare "reject" is not something an agent can act on; ask for the reason instead of starting an empty fix round.
        await opts.reply?.(`"reject" on its own does not tell me what to change. Reply "changes: …" with what is wrong, or cancel #${item.id} in the factory.`);
        return "ignored";
      }
    }
    if (changes && item.status === "review") { await reviewDecision(item.id, "changes_requested", changes, { ...who, externalId }); return "changes-requested"; }
    await ctx.feedback(item.id, { author, body: changes || text, externalId });
    return "feedback";
  } catch (e) {
    ctx.log(`#${item.id}: could not take ${who.name}'s comment: ${errText(e)}`, "warn");
    return "ignored";
  }
}
