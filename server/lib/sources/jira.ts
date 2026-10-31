// Jira Cloud: a JQL poll (REST v3, an API token, no SDK). An issue that matches (by default:
// labelled "factory" and not done) becomes a request and gets the "picked" label; progress goes
// back as comments; new comments on the issue are feedback or, while the factory waits,
// "approve"/"reject". Comments are read for open items even after the issue leaves the JQL. A
// closed item's issue that is reopened or given its trigger label again becomes a new request.
import { q } from "../../db.ts";
import { OPEN, type Item, type ItemDraft } from "../items.ts";
import type { PostMessage } from "../conversations.ts";
import { registerSource, type SourceAdapter, type SourceContext } from "./index.ts";
import { itemLink } from "../conversations.ts";
import { cfgBool, cfgStr, chunks, decisionHint, errText, fetchRetry, FetchError, handleDecisionComment, linkLines, nextExternalId, readJson } from "./util.ts";

export const DEFAULT_JQL = "labels = factory AND statusCategory != Done ORDER BY updated ASC";
const SEARCH = "/rest/api/3/search/jql"; // the old /rest/api/3/search answers 410
const FIELDS = ["summary", "description", "status", "priority", "labels", "reporter", "updated", "created", "issuetype", "comment"];
const OVERLAP_MS = 5 * 60_000; // search is eventually consistent and JQL dates have minute precision
const MAX_COMMENT = 32_000; // Jira refuses a comment over 32,767 characters; a long plan or log must still get through

export type Adf = { type: string; version?: number; text?: string; content?: Adf[]; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> };
type JiraUser = { accountId?: string; displayName?: string; emailAddress?: string; timeZone?: string };
export type JiraComment = { id: string; author?: JiraUser | null; body?: Adf | string | null; created?: string };
/** One field in a changelog entry. Its new value's name is in `toString`, which an object also inherits (a function), so it is read with ownString. */
export type JiraHistoryItem = { field?: string; from?: string | null; fromString?: string | null; to?: string | null; [k: string]: unknown };
/** One change in an issue's changelog: who, when, and the fields it touched (labels as space-separated names, status as ids). */
export type JiraHistory = { id?: string; created?: string; author?: JiraUser | null; items?: JiraHistoryItem[] };
const ownString = (o: object, k: string): string => (Object.hasOwn(o, k) && typeof (o as Record<string, unknown>)[k] === "string" ? ((o as Record<string, unknown>)[k] as string) : "");
export type JiraIssue = {
  id: string; key: string;
  fields?: {
    summary?: string; description?: Adf | string | null; labels?: string[]; updated?: string; created?: string;
    status?: { name?: string; statusCategory?: { key?: string } } | null; priority?: { id?: string; name?: string } | null;
    reporter?: JiraUser | null; issuetype?: { name?: string } | null;
    comment?: { comments?: JiraComment[]; total?: number; maxResults?: number } | null;
  };
};

// --- ADF ---------------------------------------------------------------------------------

function inline(n: Adf): string {
  let t = n.text ?? "";
  for (const m of n.marks ?? []) {
    if (m.type === "code") t = `\`${t}\``;
    else if (m.type === "strong") t = `**${t}**`;
    else if (m.type === "em") t = `_${t}_`;
    else if (m.type === "strike") t = `~~${t}~~`;
    else if (m.type === "link" && typeof m.attrs?.href === "string" && m.attrs.href !== t) t = `[${t}](${m.attrs.href})`;
  }
  return t;
}

function render(n: Adf): string {
  const a = n.attrs ?? {};
  const kids = () => (n.content ?? []).map(render).join("");
  switch (n.type) {
    case "text": return inline(n);
    case "hardBreak": return "\n";
    case "paragraph": return `${kids()}\n\n`;
    case "heading": return `${"#".repeat(Math.min(6, Math.max(1, Number(a.level) || 1)))} ${kids().trim()}\n\n`;
    case "blockquote": return `${kids().trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
    case "rule": return "---\n\n";
    case "codeBlock": return `\`\`\`${typeof a.language === "string" ? a.language : ""}\n${(n.content ?? []).map((c) => c.text ?? "").join("")}\n\`\`\`\n\n`;
    case "bulletList":
    case "orderedList": {
      const start = Number(a.order) || 1;
      // A nested list comes back already rendered; indenting the item's continuation lines nests it.
      return `${(n.content ?? []).map((li, i) => `${n.type === "orderedList" ? `${start + i}.` : "-"} ${(li.content ?? []).map(render).join("").replace(/\n{2,}/g, "\n").trim().replace(/\n/g, "\n  ")}`).join("\n")}\n\n`;
    }
    case "mention": { const t = String(a.text ?? "someone"); return t.startsWith("@") ? t : `@${t}`; }
    case "emoji": return String(a.text ?? a.shortName ?? "");
    case "inlineCard": case "blockCard": case "embedCard": return String(a.url ?? "");
    case "date": return a.timestamp ? new Date(Number(a.timestamp)).toISOString().slice(0, 10) : "";
    case "status": return `[${String(a.text ?? "")}]`;
    case "media": return `[attachment${typeof a.alt === "string" && a.alt ? `: ${a.alt}` : ""}]`;
    case "mediaSingle": case "mediaGroup": return `${kids()}\n\n`;
    case "table": return `${(n.content ?? []).map((row) => `| ${(row.content ?? []).map((cell) => (cell.content ?? []).map(render).join(" ").replace(/\s+/g, " ").trim()).join(" | ")} |`).join("\n")}\n\n`;
    case "expand": case "nestedExpand": return `${typeof a.title === "string" && a.title ? `${a.title}\n` : ""}${kids()}`;
    default: return kids(); // doc, panel, listItem outside a list, and anything new
  }
}

/** Atlassian Document Format → readable text with a little markdown (lists, code, links, headings). A string (v2, Data Center) passes through. */
export function adfToText(node: Adf | string | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node.trim();
  return render(node).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function linkify(line: string): Adf[] {
  const out: Adf[] = [];
  let last = 0;
  for (const m of line.matchAll(/https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/g)) {
    if (m.index > last) out.push({ type: "text", text: line.slice(last, m.index) });
    out.push({ type: "text", text: m[0], marks: [{ type: "link", attrs: { href: m[0] } }] });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ type: "text", text: line.slice(last) });
  return out;
}

/** Plain text → an ADF doc: a blank line starts a paragraph, a newline is a hardBreak, URLs are links. Jira rejects empty text nodes, so there are none. */
export function textToAdf(text: string, title?: string): Adf {
  const para = (p: string): Adf => ({ type: "paragraph", content: p.split("\n").flatMap((line, i): Adf[] => [...(i ? [{ type: "hardBreak" }] : []), ...linkify(line)]) });
  const content = text.split(/\n{2,}/).map((p) => p.replace(/\s+$/, "")).filter((p) => p.trim()).map(para);
  if (title?.trim()) content.unshift({ type: "paragraph", content: [{ type: "text", text: title.trim(), marks: [{ type: "strong" }] }] });
  return { type: "doc", version: 1, content: content.length ? content : [{ type: "paragraph", content: [{ type: "text", text: "…" }] }] };
}

// --- mapping -------------------------------------------------------------------------------

/** Jira's priority (by name, else the default scheme's id 1–5) → the factory's 1 (urgent) … 5. */
export function jiraPriority(p: { id?: string; name?: string } | null | undefined): number {
  const byName: Record<string, number> = { highest: 1, blocker: 1, critical: 1, high: 2, major: 2, medium: 3, normal: 3, low: 4, minor: 4, lowest: 5, trivial: 5 };
  const n = byName[(p?.name ?? "").trim().toLowerCase()];
  if (n) return n;
  const id = Number(p?.id);
  return Number.isInteger(id) && id >= 1 && id <= 5 ? id : 3;
}

/** The link people open. A scoped token's API base (api.atlassian.com/ex/jira/<cloudId>) is no place for people, so the site wins when it is known. */
export function browseUrl(key: string, baseUrl: string, siteUrl?: string | null): string {
  let site = "";
  try { site = normalizeBase(siteUrl ?? ""); } catch { /* not a URL: use the base */ }
  return `${site || baseUrl}/browse/${key}`;
}

/** A search hit → the request. The comments so far go into the body (the poller only feeds later ones back as feedback). */
export function jiraIssueToDraft(issue: JiraIssue, baseUrl: string, o: { skipLabels?: string[]; selfAccountId?: string | null; comments?: JiraComment[]; siteUrl?: string | null } = {}): ItemDraft {
  const f = issue.fields ?? {};
  const skip = new Set((o.skipLabels ?? []).map((l) => l.toLowerCase()));
  const comments = (o.comments ?? f.comment?.comments ?? [])
    .filter((c) => !o.selfAccountId || c.author?.accountId !== o.selfAccountId)
    .map((c) => `- ${c.author?.displayName ?? "someone"}${c.created ? ` (${c.created.slice(0, 10)})` : ""}: ${adfToText(c.body).replace(/\s+/g, " ").slice(0, 1000)}`)
    .slice(-20);
  const labels = [...(f.labels ?? []).filter((l) => !skip.has(l.toLowerCase())), ...(f.issuetype?.name ? [f.issuetype.name.toLowerCase()] : [])];
  return {
    title: `${issue.key}: ${f.summary?.trim() || "(no summary)"}`,
    body: [adfToText(f.description) || "(no description)", comments.length ? `Comments on ${issue.key}:\n${comments.join("\n")}` : ""].filter(Boolean).join("\n\n"),
    externalId: issue.key, externalUrl: browseUrl(issue.key, baseUrl, o.siteUrl),
    priority: jiraPriority(f.priority), labels: [...new Set(labels)],
    origin: { kind: "jira", key: issue.key, baseUrl }, requesterName: f.reporter?.displayName ?? null,
  };
}

/** JQL dates are minute-precision and read in the API user's profile time zone. */
export function jqlDate(d: Date, timeZone = "UTC"): string {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d); }
  catch { return jqlDate(d, "UTC"); } // an unknown zone name
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** The configured JQL, limited to issues updated since the cursor, oldest first (so a capped poll resumes where it stopped). */
export function sinceJql(jql: string, since: string | null): string {
  const base = jql.replace(/\s+order\s+by\s+[\s\S]*$/i, "").trim();
  const where = [base && `(${base})`, since && `updated >= "${since}"`].filter(Boolean).join(" AND ");
  return `${where} ORDER BY updated ASC`;
}

/** The comment the factory posts: title, text, what to reply instead of buttons, links. Cut to fit Jira's limit, keeping the end (what to reply, the links). */
export function commentAdf(msg: PostMessage): Adf {
  const tail = [decisionHint(msg.buttons, { where: "in a comment" }), linkLines(msg.buttons)].filter(Boolean).join("\n\n");
  const cut = "\n\n… (cut; the rest is in the factory)";
  const room = MAX_COMMENT - (msg.title?.length ?? 0) - (tail ? tail.length + 2 : 0);
  let text = msg.text;
  if (text.length > room) text = text.slice(0, Math.max(0, room - cut.length)).replace(/[\ud800-\udbff]$/, "").trimEnd() + cut;
  return textToAdf([text, tail].filter(Boolean).join("\n\n"), msg.title);
}

/** Labels a JQL asks for (`labels = x`, `labels in (x, "y")`), lower case: putting one of them back on is asking again. */
export function jqlLabels(jql: string): string[] {
  const out: string[] = [];
  for (const m of jql.matchAll(/\blabels\s*(?:=|\bin\b)\s*(\([^)]*\)|"[^"]*"|'[^']*'|[^\s()]+)/gi)) {
    out.push(...m[1].replace(/^\(|\)$/g, "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean));
  }
  return [...new Set(out)];
}

/**
 * The change that asked for an issue again after its request closed (`since`), if any: someone
 * other than the factory put a trigger label back on, or moved it out of a done status. Any other
 * update (a comment, the factory's own transition) leaves the closed request closed.
 */
export function askedAgain(histories: JiraHistory[], o: { since: string; selfAccountId: string; triggers: string[]; doneStatuses: Set<string> }): JiraHistory | null {
  const since = Date.parse(o.since);
  const words = (v: string | null | undefined) => new Set((v ?? "").toLowerCase().split(/\s+/).filter(Boolean));
  return histories.filter((h) => {
    if (!(Date.parse(h.created ?? "") > since) || h.author?.accountId === o.selfAccountId) return false;
    return (h.items ?? []).some((it) => {
      if (it.field === "labels") { const before = words(it.fromString); return [...words(ownString(it, "toString"))].some((l) => !before.has(l) && o.triggers.includes(l)); }
      if (it.field === "status") return Boolean(it.from && o.doneStatuses.has(it.from) && !(it.to && o.doneStatuses.has(it.to)));
      return false;
    });
  }).at(-1) ?? null;
}

// --- the API -------------------------------------------------------------------------------

type Client = { base: string; site: string; call: <T>(method: string, path: string, body?: unknown) => Promise<T> };

export function normalizeBase(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new Error(`"${raw}" is not a URL`); }
  // A pasted board or issue link: the site is the origin. A scoped-token base (api.atlassian.com/ex/jira/<cloudId>) keeps its path.
  return u.host.endsWith(".atlassian.net") ? u.origin : `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function client(ctx: SourceContext): Client {
  const base = normalizeBase(cfgStr(ctx.config.baseUrl));
  const email = cfgStr(ctx.config.email), token = ctx.secrets.apiToken ?? "";
  if (!base) throw new Error("no Jira base URL configured");
  if (!email || !token) throw new Error("the Jira email and API token are both needed");
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  let site = "";
  try { site = normalizeBase(cfgStr(ctx.config.siteUrl)); } catch { /* links fall back to the base */ }
  return {
    base, site: site || base,
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetchRetry(base + path, {
        method, label: `jira ${method} ${path.split("?")[0]}`, idempotent: method === "GET" || path === SEARCH,
        headers: { Authorization: auth, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 204) return undefined as T;
      return readJson<T>(res, `jira ${method} ${path.split("?")[0]}`);
    },
  };
}

const selves = new Map<string, { accountId: string; timeZone: string; at: number }>();
/** The API user: its account id tells our own comments apart, its time zone is how JQL reads dates. */
async function myself(ctx: SourceContext, j: Client): Promise<{ accountId: string; timeZone: string }> {
  const key = `${ctx.source.id}:${ctx.source.updated_at}`;
  const hit = selves.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit;
  const me = await j.call<JiraUser>("GET", "/rest/api/3/myself");
  if (!me?.accountId) throw new Error("jira /myself returned no account id");
  const v = { accountId: me.accountId, timeZone: me.timeZone || "UTC", at: Date.now() };
  selves.set(key, v);
  return v;
}

async function* search(j: Client, jql: string, fields = FIELDS): AsyncGenerator<JiraIssue> {
  let nextPageToken: string | undefined;
  for (let page = 0; page < 20; page++) { // at most 1000 a poll; the rest next time (oldest first)
    const r = await j.call<{ issues?: JiraIssue[]; nextPageToken?: string | null; isLast?: boolean } | null>("POST", SEARCH, { jql, fields, maxResults: 50, ...(nextPageToken ? { nextPageToken } : {}) });
    for (const i of r?.issues ?? []) if (i && typeof i.key === "string") yield i;
    nextPageToken = r?.nextPageToken ?? undefined;
    if (!nextPageToken || r?.isLast) return;
  }
}

/** All of an issue's comments, oldest first. The search embeds them, but not always all of them. */
async function commentsOf(j: Client, issue: JiraIssue): Promise<JiraComment[]> {
  const c = issue.fields?.comment;
  if (c && Array.isArray(c.comments) && (c.total ?? c.comments.length) <= c.comments.length) return c.comments;
  const r = await j.call<{ comments?: JiraComment[] } | null>("GET", `/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment?orderBy=-created&maxResults=100`);
  return (r?.comments ?? []).reverse();
}

const cid = (c: JiraComment) => Number(c.id) || 0;
/** The issue key of an item: later requests on the same issue are `KEY#2`, `KEY#3`. */
const keyOf = (it: Item) => (it.external_id ?? "").split("#")[0];

/** The newest page of an issue's changelog (it is listed oldest first): enough to see what happened since a request closed. */
async function recentHistory(j: Client, key: string): Promise<JiraHistory[]> {
  type Page = { values?: JiraHistory[]; total?: number } | null;
  const path = (startAt: number) => `/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=100`;
  const first = await j.call<Page>("GET", path(0));
  const got = first?.values ?? [];
  if ((first?.total ?? 0) <= got.length) return got;
  return (await j.call<Page>("GET", path(Math.max(0, (first?.total ?? 0) - 100))))?.values ?? [];
}

const categories = new Map<string, string>();
/** Which of these status ids are in the Done category, looked up once per site. Unknown ones count as not done. */
async function doneAmong(j: Client, ids: string[]): Promise<Set<string>> {
  const done = new Set<string>();
  for (const id of new Set(ids)) {
    const k = `${j.base}:${id}`;
    if (!categories.has(k)) {
      try { categories.set(k, (await j.call<{ statusCategory?: { key?: string } } | null>("GET", `/rest/api/3/status/${encodeURIComponent(id)}`))?.statusCategory?.key ?? ""); }
      catch { continue; }
    }
    if (categories.get(k) === "done") done.add(id);
  }
  return done;
}

// A closed item whose issue was already looked at, by the issue's updated time: unchanged since, it has not been asked for again.
const settled = new Map<string, string>();

type Cursor = { lastUpdated: string | null; seenComments: Record<string, number> };
function readCursor(raw: Record<string, unknown> | null | undefined): Cursor {
  const c = raw ?? {};
  const seen = c.seenComments && typeof c.seenComments === "object" ? (c.seenComments as Record<string, unknown>) : {};
  return { lastUpdated: typeof c.lastUpdated === "string" ? c.lastUpdated : null, seenComments: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, Number(v) || 0])) };
}

type Me = { accountId: string; timeZone: string };

/** New comments on an item's issue: our own are skipped, earlier ones were in the request's body. */
async function readComments(ctx: SourceContext, j: Client, me: Me, item: Item, issue: JiraIssue, cursor: Cursor): Promise<void> {
  const after = cursor.seenComments[issue.key] ?? 0;
  const fresh = (await commentsOf(j, issue)).filter((c) => cid(c) > after).sort((a, b) => cid(a) - cid(b));
  for (const c of fresh) {
    cursor.seenComments[issue.key] = Math.max(cursor.seenComments[issue.key] ?? 0, cid(c));
    if (c.author?.accountId === me.accountId) continue;
    if (c.created && Date.parse(c.created) < Date.parse(item.created_at)) continue;
    const text = adfToText(c.body);
    if (!text) continue;
    await handleDecisionComment(ctx, item, text, c.author?.displayName ?? null, `comment:${c.id}`, { createdAt: c.created, identities: [c.author?.accountId, c.author?.emailAddress], reply: (t) => adapter.post!(ctx, item, { text: t }) });
  }
}

/** Whether a closed item's issue was asked for again since the item closed (see askedAgain). */
async function reasked(ctx: SourceContext, j: Client, me: Me, issue: JiraIssue, prior: Item, triggers: string[]): Promise<boolean> {
  const memo = `${ctx.source.id}:${prior.id}`;
  if (issue.fields?.updated && settled.get(memo) === issue.fields.updated) return false;
  const histories = await recentHistory(j, issue.key);
  const statusIds = histories.flatMap((h) => (h.items ?? []).filter((it) => it.field === "status").flatMap((it) => [it.from, it.to])).filter((x): x is string => Boolean(x));
  const hit = askedAgain(histories, { since: prior.finished_at ?? prior.updated_at, selfAccountId: me.accountId, triggers, doneStatuses: await doneAmong(j, statusIds) });
  if (!hit && issue.fields?.updated) { settled.set(memo, issue.fields.updated); if (settled.size > 2000) settled.delete(settled.keys().next().value!); }
  return Boolean(hit);
}

async function takeIssue(ctx: SourceContext, j: Client, me: Me, issue: JiraIssue, picked: string, cursor: Cursor, triggers: string[]): Promise<void> {
  const prior = await ctx.latestItem(issue.key);
  if (prior && OPEN.includes(prior.status)) { await readComments(ctx, j, me, prior, issue, cursor); return; }
  // A closed request stays closed while its issue is merely updated (the factory's last comment, for one).
  if (prior && !(await reasked(ctx, j, me, issue, prior, triggers))) return;
  const comments = await commentsOf(j, issue).catch(() => issue.fields?.comment?.comments ?? []);
  const draft = jiraIssueToDraft(issue, j.base, { skipLabels: [picked, "factory"].filter(Boolean), selfAccountId: me.accountId, comments, siteUrl: j.site });
  if (prior) { draft.externalId = nextExternalId(issue.key, prior.external_id); draft.body = `${draft.body}\n\nAsked for again after #${prior.id} (${prior.status}).`; }
  const r = await ctx.createItem(draft);
  cursor.seenComments[issue.key] = Math.max(cursor.seenComments[issue.key] ?? 0, ...comments.map(cid));
  if (!r.created) return;
  ctx.log(`#${r.item.id} from ${issue.key}${prior ? ` (asked again after #${prior.id})` : ""}`);
  if (prior) await adapter.post!(ctx, r.item, { text: `#${prior.id} for this issue is ${prior.status}, so I took this as a new request, #${r.item.id} (${itemLink(r.item.id)}), linked to #${prior.id}.` }).catch((e) => ctx.log(`${issue.key}: could not comment: ${errText(e)}`, "warn"));
  if (picked && !(issue.fields?.labels ?? []).includes(picked)) {
    await j.call("PUT", `/rest/api/3/issue/${encodeURIComponent(issue.key)}`, { update: { labels: [{ add: picked }] } })
      .catch((e) => ctx.log(`${issue.key}: could not add the ${picked} label: ${errText(e)}`, "warn"));
  }
}

async function transition(j: Client, key: string, name: string): Promise<void> {
  const r = await j.call<{ transitions?: Array<{ id: string; name?: string; to?: { name?: string } }> } | null>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  const want = name.trim().toLowerCase();
  const t = (r?.transitions ?? []).find((x) => x.name?.toLowerCase() === want || x.to?.name?.toLowerCase() === want);
  if (!t) throw new Error(`no transition "${name}" from its current status (available: ${(r?.transitions ?? []).map((x) => x.name).join(", ") || "none"})`);
  await j.call("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
}

const adapter: SourceAdapter = {
  kind: "jira",
  label: "Jira",
  description: "Polls Jira Cloud with a JQL query (by default issues labelled \"factory\" that are not done). Each issue becomes a request; progress is commented back; comments are feedback, and \"approve\"/\"reject\" decide while the factory waits.",
  help: `Create an API token at id.atlassian.com/manage-profile/security/api-tokens, ideally for a bot account: the factory comments as that user. It needs Browse projects, Add comments and Edit issues (for the picked label), and Transition issues if you set a done transition. Base URL is the site, e.g. https://yourteam.atlassian.net.`,
  defaultIntervalSec: 60,
  fields: [
    { key: "approvers", label: "Who may approve", placeholder: "5b10ac8d82e05b22cc7d4ef5, priya@yourteam.com", help: "Jira account ids (the id at the end of the person's profile URL, …/jira/people/<id>) or email addresses, comma-separated. Emails are often hidden by profile privacy, so account ids are safer. Display names never count. Empty: anyone who can comment on the issue." },
    { key: "baseUrl", label: "Base URL", required: true, placeholder: "https://yourteam.atlassian.net", help: "The site. With a scoped API token: https://api.atlassian.com/ex/jira/<cloudId>, and fill in the site URL below." },
    { key: "siteUrl", label: "Site URL", placeholder: "https://yourteam.atlassian.net", help: "Where links to issues point. Only needed when the base URL is api.atlassian.com; empty: the base URL." },
    { key: "email", label: "Email", required: true, placeholder: "factory-bot@yourteam.com", help: "The Atlassian account the API token belongs to." },
    { key: "apiToken", label: "API token", secret: true, required: true },
    { key: "jql", label: "JQL", kind: "textarea", default: DEFAULT_JQL, placeholder: DEFAULT_JQL, help: "Which issues become requests. The factory adds its own \"updated since\" limit." },
    { key: "pickedLabel", label: "Picked label", default: "factory-picked", placeholder: "factory-picked", help: "Added to an issue when it is taken. Empty: leave the labels alone." },
    { key: "doneTransition", label: "Done transition", placeholder: "Done", help: "Optional: the transition (or target status) to apply when the request is done." },
    { key: "commentBack", label: "Comment status back", kind: "boolean", default: true },
  ],
  async poll(ctx) {
    const j = client(ctx);
    const me = await myself(ctx, j);
    const cursor = readCursor(ctx.source.cursor);
    const jql = cfgStr(ctx.config.jql) || DEFAULT_JQL;
    const picked = cfgStr(ctx.config.pickedLabel, "factory-picked").replace(/\s+/g, "-");
    const triggers = jqlLabels(jql).filter((l) => l !== picked.toLowerCase());
    const since = cursor.lastUpdated ? jqlDate(new Date(Date.parse(cursor.lastUpdated) - OVERLAP_MS), me.timeZone) : null;
    let maxUpdated = cursor.lastUpdated ? Date.parse(cursor.lastUpdated) : 0;
    const bump = (issue: JiraIssue) => { const u = Date.parse(issue.fields?.updated ?? ""); if (u > maxUpdated) maxUpdated = u; };
    const seen = new Set<string>();
    for await (const issue of search(j, sinceJql(jql, since))) {
      seen.add(issue.key);
      bump(issue);
      try { await takeIssue(ctx, j, me, issue, picked, cursor, triggers); } catch (e) { ctx.log(`${issue.key}: ${errText(e)}`, "warn"); }
    }
    // Open items whose issue no longer matches the JQL (status moved, label changed) still have their comments read.
    const open = await q<Item>("select * from work_items where source_id = $1 and status = any($2) and external_id is not null", [ctx.source.id, OPEN]);
    const missing = open.filter((it) => !seen.has(keyOf(it)));
    for (const batch of chunks(missing, 50)) {
      const byKey = new Map(batch.map((it) => [keyOf(it), it]));
      let found: JiraIssue[] = [];
      try {
        for await (const issue of search(j, sinceJql(`key in (${[...byKey.keys()].map((k) => `"${k.replace(/"/g, "")}"`).join(", ")})`, since), ["updated", "comment"])) found.push(issue);
      } catch (e) {
        // A deleted or moved key makes the whole JQL fail; fall back to one issue at a time.
        if (!(e instanceof FetchError && e.status === 400)) throw e;
        found = [];
        for (const key of byKey.keys()) {
          try { found.push(await j.call<JiraIssue>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=updated,comment`)); }
          catch (err) { if (!(err instanceof FetchError && err.status === 404)) ctx.log(`${key}: ${errText(err)}`, "warn"); }
        }
      }
      for (const issue of found) {
        const item = byKey.get(issue.key);
        if (!item) continue;
        bump(issue);
        try { await readComments(ctx, j, me, item, issue, cursor); } catch (e) { ctx.log(`${issue.key}: ${errText(e)}`, "warn"); }
      }
    }
    // Comment cursors are only worth keeping while the item is open.
    const keep = new Set([...open.map(keyOf), ...seen]);
    for (const k of Object.keys(cursor.seenComments)) if (!keep.has(k)) delete cursor.seenComments[k];
    await ctx.saveCursor({ lastUpdated: maxUpdated ? new Date(maxUpdated).toISOString() : cursor.lastUpdated, seenComments: cursor.seenComments });
  },
  async post(ctx, item, msg) {
    const o = item.origin as { kind: "jira"; key?: string };
    if (!o?.key) return;
    const j = client(ctx);
    const ref: { key: string; commentId?: string } = { key: o.key };
    if (cfgBool(ctx.config.commentBack, true)) {
      const r = await j.call<{ id?: string } | null>("POST", `/rest/api/3/issue/${encodeURIComponent(o.key)}/comment`, { body: commentAdf(msg) });
      if (r?.id) ref.commentId = r.id;
    }
    const done = cfgStr(ctx.config.doneTransition);
    if (done && item.status === "done") await transition(j, o.key, done).then(() => ctx.log(`${o.key}: moved to ${done}`)).catch((e) => ctx.log(`${o.key}: ${errText(e)}`, "warn"));
    return { ref };
  },
  async test(ctx) {
    try {
      const j = client(ctx);
      const me = await j.call<JiraUser>("GET", "/rest/api/3/myself");
      const r = await j.call<{ issues?: unknown[] } | null>("POST", SEARCH, { jql: cfgStr(ctx.config.jql) || DEFAULT_JQL, maxResults: 5, fields: ["summary"] });
      const n = r?.issues?.length ?? 0;
      return { ok: true, detail: `signed in as ${me.displayName ?? "?"}${me.emailAddress ? ` (${me.emailAddress})` : ""}; the JQL matches ${n >= 5 ? "5 or more" : n} issue(s) now` };
    } catch (e) {
      return { ok: false, detail: errText(e) };
    }
  },
};

export function register(): void { registerSource(adapter); }
