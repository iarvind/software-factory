// Slack over Socket Mode: the factory opens a WebSocket to Slack, so nothing has to reach this
// Mac from outside. A mention, a DM, the trigger emoji or /factory starts a request; a reply in
// the request's thread is feedback (or "approve"/"reject"); the buttons under a status post
// decide the gate. After a restart or a dropped connection, the trigger channels are read back
// from the newest message seen. Plain fetch and the global WebSocket, no Slack SDK.
import { q, one } from "../../db.ts";
import { OPEN, type Item } from "../items.ts";
import { activeRuns, decide, reviewDecision } from "../pipeline.ts";
import { itemLink, type PostMessage } from "../conversations.ts";
import { registerSource, type SourceAdapter, type SourceContext } from "./index.ts";
import { cfgBool, cfgList, cfgStr, changesRequested, errText, fetchRetry, handleDecisionComment, isDecision, readJson, serialize, sleep, titleFrom, toMrkdwn, mayDecide } from "./util.ts";

type SlackOrigin = { kind: "slack"; team?: string; channel: string; ts: string; thread_ts?: string; user?: string };
type SlackMessage = {
  ts: string; thread_ts?: string; user?: string; bot_id?: string; username?: string; text?: string; subtype?: string; team?: string; user_team?: string;
  reactions?: Array<{ name?: string; users?: string[] }>;
};
// Slack payloads are wide and loosely typed; we read them defensively.
type Json = Record<string, any>;

/** Paste this when creating the app (api.slack.com/apps → Create New App → From an app manifest). */
export const appManifest = {
  _metadata: { major_version: 2, minor_version: 1 },
  display_information: { name: "Software Factory", description: "Turns requests into changes and reports back in the thread.", background_color: "#1f2937" },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "factory", always_online: true },
    slash_commands: [{ command: "/factory", description: "Ask the factory for something, or see what it is doing", usage_hint: "<what you want done> | status", should_escape: false }],
  },
  oauth_config: {
    scopes: { bot: ["app_mentions:read", "channels:history", "groups:history", "im:history", "mpim:history", "chat:write", "reactions:read", "reactions:write", "users:read", "commands"] },
  },
  settings: {
    // message.groups and message.mpim: so replies in private-channel and group-DM threads count too (their history scopes are already asked for).
    event_subscriptions: { bot_events: ["app_mention", "message.im", "message.mpim", "message.channels", "message.groups", "reaction_added"] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

const HELP = `1. api.slack.com/apps → Create New App → From an app manifest → pick the workspace → paste the manifest below.
2. Basic Information → App-Level Tokens → Generate, with the scope connections:write. That is the xapp-… token.
3. Install App → Install to workspace. Copy the Bot User OAuth Token (xoxb-…).
4. Invite the bot where people should ask it for things: /invite @factory.
Channel ids are under the channel's name → About (they start with C, or G for private channels).

Manifest:
${JSON.stringify(appManifest, null, 2)}`;

// --- the Web API -------------------------------------------------------------------------

/** Slack said no (HTTP 200, ok: false): the error code says why. */
export class SlackError extends Error {
  code: string;
  constructor(method: string, code: string, detail = "") { super(`slack ${method}: ${code}${detail}`); this.code = code; }
}

// Reads may be repeated after a network error; a post may not (it would post twice).
const READS = new Set(["auth.test", "apps.connections.open", "users.info", "conversations.history", "conversations.replies", "chat.getPermalink"]);

async function slack<T = Json>(token: string | undefined, method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!token) throw new Error(`slack ${method}: no token configured`);
  // Form encoding works for every method (JSON bodies do not for the reads); objects go as JSON strings.
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  const res = await fetchRetry(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" }, body, idempotent: READS.has(method), label: `slack ${method}`, timeoutMs: 15_000 });
  const json = await readJson<Json | null>(res, `slack ${method}`);
  if (!json?.ok) throw new SlackError(method, String(json?.error ?? "unknown_error"), json?.needed ? ` (the app needs the ${json.needed} scope: add it and reinstall the app)` : "");
  return json as T;
}

/** Ephemeral answers to a slash command or a button press go to its response_url (no token needed, 5 uses in 30 minutes). */
async function respond(url: unknown, text: string): Promise<void> {
  if (typeof url !== "string" || !url.startsWith("https://hooks.slack.com/")) return;
  await fetchRetry(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }), label: "slack response_url", timeoutMs: 10_000 }).catch(() => {});
}

const names = new Map<string, { name: string; at: number }>();
/** A person's display name, cached for an hour. Falls back to the id: a name is never worth failing a request over. */
async function userName(ctx: SourceContext, id: string | undefined): Promise<string> {
  if (!id) return "someone";
  const key = `${ctx.source.id}:${id}`;
  const hit = names.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.name;
  try {
    const r = await slack<{ user?: Json }>(ctx.secrets.botToken, "users.info", { user: id });
    const u = r.user ?? {};
    const name = String(u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || id);
    names.set(key, { name, at: Date.now() });
    if (names.size > 5000) names.delete(names.keys().next().value!);
    return name;
  } catch {
    return hit?.name ?? id;
  }
}

async function react(ctx: SourceContext, channel: string, ts: string, name: string): Promise<void> {
  try { await slack(ctx.secrets.botToken, "reactions.add", { channel, timestamp: ts, name }); }
  catch (e) { if (!(e instanceof SlackError && e.code === "already_reacted")) ctx.log(`could not react :${name}: on ${channel}:${ts}: ${errText(e)}`, "warn"); }
}

// --- text both ways ------------------------------------------------------------------------

/** Slack markup → plain text: <@U1> → @name, <#C1|general> → #general, <url|label> → label (url), &amp; → &. The bot's own mention is dropped. */
export function slackToText(text: string, nameOf: (id: string) => string | undefined = () => undefined, dropUser?: string | null): string {
  return text
    .replace(/<([^<>\n]+)>/g, (_m, inner: string) => {
      const bar = inner.indexOf("|");
      const target = bar < 0 ? inner : inner.slice(0, bar);
      const label = bar < 0 ? "" : inner.slice(bar + 1);
      if (target.startsWith("@")) {
        const id = target.slice(1);
        if (dropUser && id === dropUser) return "";
        return `@${(label || nameOf(id) || id).replace(/^@/, "")}`;
      }
      if (target.startsWith("#")) return `#${label || target.slice(1)}`;
      if (target.startsWith("!")) return label || `@${target.slice(1).split("^")[0]}`; // <!here>, <!subteam^S1|@eng>, <!date^…|fallback>
      if (target.startsWith("mailto:")) return label || target.slice(7);
      if (!label || label === target || target.replace(/^https?:\/\//, "").replace(/\/$/, "") === label) return target;
      return `${label} (${target})`;
    })
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Converts a message's markup after looking up the names of the people it mentions. */
async function plainText(ctx: SourceContext, botUser: string | null, raw: string): Promise<string> {
  const ids = [...new Set([...raw.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))].filter((id) => id !== botUser).slice(0, 20);
  const found = new Map(await Promise.all(ids.map(async (id) => [id, await userName(ctx, id)] as const)));
  return slackToText(raw, (id) => found.get(id), botUser);
}

/** Where to cut at or before `max` without splitting a link (<url|label>), an escape (&amp; &lt; &gt;) or an emoji's surrogate pair: Slack would show the halves as junk. */
function safeCut(text: string, max: number): number {
  let cut = max;
  const lt = text.lastIndexOf("<", cut - 1);
  if (lt > 0 && lt > text.lastIndexOf(">", cut - 1)) cut = lt;
  const amp = text.lastIndexOf("&", cut - 1);
  if (amp > 0 && amp > text.lastIndexOf(";", cut - 1) && cut - amp < 8) cut = amp;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return Math.max(1, cut); // never zero: the caller would loop
}

/** Splits mrkdwn into pieces that fit a section block (3000 characters), on line breaks where possible. */
export function pieces(text: string, max = 2900): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = safeCut(rest, max);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.trim() || !out.length) out.push(rest || " ");
  return out;
}

/** A status post as Block Kit: the text in sections, then the buttons (value = the data string the factory understands). */
export function postBlocks(msg: PostMessage): { text: string; blocks: Json[] } {
  const icon = { success: ":white_check_mark: ", warning: ":warning: ", error: ":x: ", info: "" }[msg.level ?? "info"];
  const full = `${icon}${msg.title ? `*${toMrkdwn(msg.title)}*\n` : ""}${toMrkdwn(msg.text)}`;
  const blocks: Json[] = pieces(full).slice(0, 10).map((t) => ({ type: "section", text: { type: "mrkdwn", text: t } }));
  const used = new Set<string>();
  const buttons = (msg.buttons ?? []).slice(0, 5).map((b, i): Json => {
    const label = { type: "plain_text", text: b.text.slice(0, 75), emoji: true };
    if ("url" in b) return { type: "button", action_id: `link-${i}`, text: label, url: b.url };
    const verb = b.data.split(":")[0];
    const actionId = used.has(verb) ? `${verb}-${i}` : verb; // action ids must be unique within the block
    used.add(verb);
    const btn: Json = { type: "button", action_id: actionId, text: label, value: b.data.slice(0, 2000) };
    if (verb === "approve" || verb === "review-approve") btn.style = "primary";
    if (verb === "reject") {
      btn.style = "danger";
      btn.confirm = { title: { type: "plain_text", text: "Decline?" }, text: { type: "plain_text", text: "A declined plan cancels the request; a declined merge or deploy parks it." }, confirm: { type: "plain_text", text: b.text.slice(0, 30) || "Decline" }, deny: { type: "plain_text", text: "Keep" } };
    }
    return btn;
  });
  if (buttons.length) blocks.push({ type: "actions", block_id: "factory", elements: buttons });
  return { text: toMrkdwn(msg.text).slice(0, 3000), blocks };
}

const tsDate = (ts: string) => new Date(Number(ts) * 1000);

/** Orders Slack timestamps ("1700000000.000200") exactly; as numbers they would lose their last digits. */
export function cmpTs(a: string, b: string): number {
  const [ai = "0", af = ""] = a.split("."), [bi = "0", bf = ""] = b.split(".");
  const d = Number(ai) - Number(bi);
  if (d) return d;
  const x = af.padEnd(6, "0"), y = bf.padEnd(6, "0");
  return x < y ? -1 : x > y ? 1 : 0;
}
const slackNow = (agoMs = 0) => ((Date.now() - agoMs) / 1000).toFixed(6);
// How far back a catch-up reads: a weekend's outage, not a month a source spent switched off (those asks are stale; people ask again).
const CATCH_UP_MS = 72 * 3600_000;

// --- the live connection -----------------------------------------------------------------

type Live = {
  ctx: SourceContext;
  botUser: string | null;
  team: string | null;
  channels: Set<string>;
  emoji: Set<string>;
  requireMention: boolean;
  seen: (id: string) => boolean;
  /** Per trigger channel, the newest message seen: where the catch-up after a gap starts. Kept in the source's cursor. */
  lastTs: Map<string, string>;
  noteTs: (channel: string, ts: string) => void;
  stopped: () => boolean;
};

type Intake = { channel: string; ts: string; threadTs?: string; user: string; team?: string | null; text: string; note?: string; react?: boolean; via: string };

/**
 * The item a thread belongs to. Its first request has the external id channel:thread-root; a later
 * request asked in the thread after that one closed has channel:its-own-ts. The open one wins.
 */
async function threadItem(ctx: SourceContext, channel: string, root: string): Promise<Item | null> {
  const first = await ctx.itemByExternalId(`${channel}:${root}`);
  if (!first || OPEN.includes(first.status)) return first; // a thread with a later request always has a first one
  return (await one<Item>(
    "select * from work_items where source_id = $1 and origin->>'channel' = $2 and origin->>'thread_ts' = $3 order by (status = any($4)) desc, id desc limit 1",
    [ctx.source.id, channel, root, OPEN],
  )) ?? first;
}

/** A new request from a message. One open request per thread; a closed one does not swallow a new ask, which becomes its own request, linked to it. */
async function intake(s: Live, t: Intake): Promise<{ item: Item; created: boolean } | null> {
  const { ctx } = s;
  const root = t.threadTs ?? t.ts;
  const own = await ctx.itemByExternalId(`${t.channel}:${t.ts}`);
  if (own) return { item: own, created: false };
  const prior = await threadItem(ctx, t.channel, root);
  // While the thread's request is open, more asks in it are its business; the same message flagged again is not a new ask either.
  if (prior && (OPEN.includes(prior.status) || (prior.origin as SlackOrigin).ts === t.ts)) return { item: prior, created: false };
  const externalId = prior ? `${t.channel}:${t.ts}` : `${t.channel}:${root}`;
  const requester = await userName(ctx, t.user);
  const context = t.threadTs ? await threadContext(s, t.channel, t.threadTs, t.ts) : "";
  if (!t.text && !context) {
    await slack(ctx.secrets.botToken, "chat.postMessage", { channel: t.channel, thread_ts: root, text: "What should I do? Mention me again with the request, e.g. “@factory add a CSV export to the reports page”." }).catch(() => {});
    return null;
  }
  const permalink = await slack<{ permalink?: string }>(ctx.secrets.botToken, "chat.getPermalink", { channel: t.channel, message_ts: t.ts }).then((r) => r.permalink ?? null).catch(() => null);
  const origin: SlackOrigin = { kind: "slack", ...(t.team ? { team: t.team } : {}), channel: t.channel, ts: t.ts, ...(t.threadTs ? { thread_ts: t.threadTs } : {}), user: t.user };
  const r = await ctx.createItem({
    title: titleFrom(t.text || context, `Slack request from ${requester}`),
    body: [t.text, t.note, prior && `Asked in the thread of #${prior.id} (${prior.status}).`, context && `Earlier in the thread:\n${context}`].filter(Boolean).join("\n\n"),
    externalId, externalUrl: permalink, origin, requesterName: requester,
  });
  if (r.created) {
    ctx.log(`#${r.item.id} from ${requester} (${t.via})${prior ? `, after #${prior.id}` : ""}`);
    if (t.react !== false) await react(ctx, t.channel, t.ts, "eyes");
    if (prior) {
      await slack(ctx.secrets.botToken, "chat.postMessage", { channel: t.channel, thread_ts: root, unfurl_links: false, text: `<${itemLink(prior.id)}|#${prior.id}> is ${prior.status.replace("_", " ")}, so I took this as a new request, <${itemLink(r.item.id)}|#${r.item.id}>, linked to #${prior.id}.` })
        .catch((e) => ctx.log(`could not say #${r.item.id} follows #${prior.id}: ${errText(e)}`, "warn"));
    }
  }
  return r;
}

/** The thread a request was made in, up to the request, as "name: text" lines, so the agent sees what "this" refers to. */
async function threadContext(s: Live, channel: string, root: string, exceptTs: string): Promise<string> {
  try {
    // The 30 messages just before the request (a long thread's start is the least relevant part).
    const r = await slack<{ messages?: SlackMessage[] }>(s.ctx.secrets.botToken, "conversations.replies", { channel, ts: root, latest: exceptTs, inclusive: false, limit: 30 });
    const lines: string[] = [];
    for (const m of r.messages ?? []) {
      if (m.ts === exceptTs) continue;
      const text = await plainText(s.ctx, s.botUser, m.text ?? "");
      if (text) lines.push(`${m.bot_id ? (m.username ?? "a bot") : await userName(s.ctx, m.user)}: ${text}`);
    }
    return lines.join("\n").slice(0, 6000);
  } catch (e) {
    s.ctx.log(`could not read the thread ${channel}:${root}: ${errText(e)}`, "warn");
    return "";
  }
}

/** The message a reaction points at: conversations.history finds top-level ones, conversations.replies thread replies. */
async function fetchMessage(ctx: SourceContext, channel: string, ts: string): Promise<SlackMessage | null> {
  try {
    const h = await slack<{ messages?: SlackMessage[] }>(ctx.secrets.botToken, "conversations.history", { channel, oldest: ts, latest: ts, inclusive: true, limit: 1 });
    const m = h.messages?.find((x) => x.ts === ts);
    if (m) return m;
  } catch (e) { if (!(e instanceof SlackError)) throw e; }
  try {
    const r = await slack<{ messages?: SlackMessage[] }>(ctx.secrets.botToken, "conversations.replies", { channel, ts, oldest: ts, latest: ts, inclusive: true, limit: 5 });
    return r.messages?.find((x) => x.ts === ts) ?? null;
  } catch (e) {
    ctx.log(`could not read ${channel}:${ts} (is the bot in that channel?): ${errText(e)}`, "warn");
    return null;
  }
}

async function onEvent(s: Live, payload: Json): Promise<void> {
  const e = payload?.event as Json | undefined;
  if (!e || typeof e !== "object") return;
  if (typeof payload.event_id === "string" && s.seen(payload.event_id)) return; // Slack retries carry the same event id
  if (e.type === "reaction_added") return onReaction(s, e);
  if (e.type !== "app_mention" && e.type !== "message") return;
  return onMessage(s, e);
}

/** A message, live or read back after a gap (`late`): a reply in a request's thread, or perhaps a new request. */
async function onMessage(s: Live, e: Json, late = false): Promise<void> {
  const { ctx } = s;
  const channel = String(e.channel ?? ""), ts = String(e.ts ?? "");
  if (!channel || !ts) return;
  s.noteTs(channel, ts);
  // Never the bot's own posts (or any bot's), and not edits, deletions or joins.
  if (e.bot_id || !e.user || e.user === s.botUser) return;
  if (e.subtype && e.subtype !== "thread_broadcast" && e.subtype !== "file_share") return;
  const threadTs = e.thread_ts && e.thread_ts !== e.ts ? String(e.thread_ts) : undefined;
  const im = e.channel_type === "im";
  const raw = String(e.text ?? "");
  // A channel message that mentions the bot also arrives as app_mention; take it once, from there.
  if (e.type === "message" && !im && s.botUser && raw.includes(`<@${s.botUser}>`)) return;
  await serialize(`slack:${ctx.source.id}:${channel}:${threadTs ?? ts}`, async () => {
    let prior: Item | null = null;
    if (threadTs) {
      const item = await threadItem(ctx, channel, threadTs);
      if (item) {
        if ((item.origin as SlackOrigin).ts === ts) return; // the message that started it
        // A mention in the thread of a finished request asks for something new (intake links the two); anything else is a reply.
        if (OPEN.includes(item.status) || e.type !== "app_mention") return onReply(s, item, e, channel, ts, threadTs, raw);
        prior = item;
      }
    }
    // A new request: any DM, a mention in a trigger channel (or in a thread the factory already worked in), or (when no mention is needed) any top-level message in one.
    const listed = s.channels.has(channel);
    const allowed = s.channels.size === 0 || listed || Boolean(prior);
    const trigger = im || (e.type === "app_mention" && allowed) || (e.type === "message" && !s.requireMention && listed && !threadTs);
    if (!trigger) return;
    const via = im ? "DM" : e.type === "app_mention" ? "mention" : "message";
    await intake(s, { channel, ts, threadTs, user: e.user, team: e.team ?? s.team, text: await plainText(ctx, s.botUser, raw), via: late ? `${via}, caught up` : via });
  });
}

/** A reply in an item's thread: feedback, an answer, or a verdict from someone allowed to give one. */
async function onReply(s: Live, item: Item, e: Json, channel: string, ts: string, threadTs: string, raw: string): Promise<void> {
  const { ctx } = s;
  const text = await plainText(ctx, s.botUser, raw);
  if (!text) return;
  const author = await userName(ctx, e.user);
  const reply = (t: string) => slack(ctx.secrets.botToken, "chat.postMessage", { channel, thread_ts: threadTs, text: toMrkdwn(t) });
  // Someone from another workspace in a Slack Connect channel is heard but never decides, approvers list or not.
  if (s.team && e.user_team && e.user_team !== s.team) {
    if (isDecision(text) || changesRequested(text)) await reply("People outside this workspace cannot decide; I kept that as a comment.").catch(() => {});
    await ctx.feedback(item.id, { author, body: text, externalId: ts });
    await react(ctx, channel, ts, "eyes");
    return;
  }
  const out = await handleDecisionComment(ctx, item, text, author, ts, { createdAt: tsDate(ts), identities: [e.user], reply });
  if (out !== "ignored") await react(ctx, channel, ts, out === "approved" || out === "review-approved" ? "white_check_mark" : out === "rejected" ? "x" : "eyes");
}

async function onReaction(s: Live, e: Json): Promise<void> {
  const { ctx } = s;
  if (!s.emoji.has(String(e.reaction ?? "").split("::")[0])) return; // skin tones arrive as name::skin-tone-2
  const channel = String(e.item?.channel ?? ""), ts = String(e.item?.ts ?? "");
  if (e.item?.type !== "message" || !channel || !ts || !e.user || e.user === s.botUser) return;
  if (s.channels.size && !s.channels.has(channel) && !channel.startsWith("D")) return;
  const m = await fetchMessage(ctx, channel, ts);
  if (m) await flagged(s, channel, m, String(e.user), String(e.reaction));
}

/** A message someone reacted to with the trigger emoji: a request on behalf of whoever reacted (the reactor is who is asking). */
async function flagged(s: Live, channel: string, m: SlackMessage, reactor: string, reaction: string, late = false): Promise<void> {
  const { ctx } = s;
  if (m.bot_id || m.user === s.botUser) return;
  const threadTs = m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined;
  await serialize(`slack:${ctx.source.id}:${channel}:${threadTs ?? m.ts}`, async () => {
    const who = await userName(ctx, reactor);
    const author = await userName(ctx, m.user);
    const text = await plainText(ctx, s.botUser, m.text ?? "");
    const via = `:${reaction}:${late ? ", caught up" : ""}`;
    await intake(s, { channel, ts: m.ts, threadTs, user: reactor, team: s.team, text, note: m.user && m.user !== reactor ? `(Written by ${author}; ${who} flagged it for the factory with :${reaction}:.)` : undefined, via });
  });
}

/**
 * After a gap (a restart, a dropped socket), each trigger channel's messages since the newest one
 * seen, taken as the live events would have taken them: mentions, the trigger emoji, and (when no
 * mention is needed) any top-level message. Ones that are already items are left alone. Replies
 * inside threads are not in a channel's history, so a mention in a thread during the gap is missed.
 */
async function backfill(s: Live): Promise<void> {
  const { ctx } = s;
  type Page = { messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
  for (const channel of s.channels) {
    if (s.stopped()) return;
    const seen = s.lastTs.get(channel);
    // Never read before: nothing to catch up on, and old messages are not new requests. From now on it is.
    if (!seen) { s.noteTs(channel, slackNow()); continue; }
    const floor = slackNow(CATCH_UP_MS);
    const oldest = cmpTs(seen, floor) < 0 ? floor : seen;
    if (oldest !== seen) ctx.log(`catching up on ${channel}: the last message seen is over ${CATCH_UP_MS / 3600_000} h old; reading only the last ${CATCH_UP_MS / 3600_000} h`, "warn");
    const found: SlackMessage[] = [];
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await slack<Page>(ctx.secrets.botToken, "conversations.history", { channel, oldest, inclusive: false, limit: 100, cursor });
        found.push(...(r.messages ?? []));
        cursor = r.response_metadata?.next_cursor || undefined;
        if (!r.has_more || !cursor) break;
        if (page === 4) ctx.log(`catching up on ${channel}: over 500 messages since the last one seen; only the newest 500 were read`, "warn");
      }
    } catch (e) {
      ctx.log(`could not catch up on ${channel}: ${errText(e)}`, "warn");
      continue;
    }
    for (const m of found.filter((x) => x.ts && cmpTs(x.ts, oldest) > 0).sort((a, b) => cmpTs(a.ts, b.ts))) {
      if (s.stopped()) return;
      try { await fromHistory(s, channel, m); } catch (e) { ctx.log(`catching up on ${channel}:${m.ts}: ${errText(e)}`, "warn"); }
    }
  }
}

/** One message read back from a channel's history, through the same intake as a live one. */
async function fromHistory(s: Live, channel: string, m: SlackMessage): Promise<void> {
  s.noteTs(channel, m.ts);
  if (m.bot_id || !m.user || m.user === s.botUser) return;
  const mentioned = Boolean(s.botUser && (m.text ?? "").includes(`<@${s.botUser}>`));
  if (mentioned || !s.requireMention) await onMessage(s, { ...m, type: mentioned ? "app_mention" : "message", channel, channel_type: "channel" }, true);
  const r = (m.reactions ?? []).find((x) => s.emoji.has(String(x.name ?? "").split("::")[0]) && (x.users ?? []).some((u) => u !== s.botUser));
  const reactor = r?.users?.find((u) => u !== s.botUser);
  if (r && reactor) await flagged(s, channel, m, reactor, String(r.name), true);
}

async function statusText(ctx: SourceContext): Promise<string> {
  const counts = await q<{ status: string; n: number }>("select status, count(*)::int as n from work_items where status = any($1) group by status order by n desc", [OPEN]);
  const mine = await q<{ id: number; title: string; status: string }>("select id, title, status from work_items where source_id = $1 and status = any($2) order by updated_at desc limit 8", [ctx.source.id, OPEN]);
  const runs = activeRuns();
  return [
    `*The factory:* ${runs.length} run(s) going${runs.length ? ` (${runs.map((r) => `#${r.itemId} ${r.kind}`).join(", ")})` : ""}.`,
    counts.length ? counts.map((c) => `${c.status.replace("_", " ")}: ${c.n}`).join(" · ") : "Nothing open.",
    ...mine.map((i) => `• <${itemLink(i.id)}|#${i.id}> ${toMrkdwn(i.title)} — ${i.status.replace("_", " ")}`),
  ].join("\n");
}

async function onCommand(s: Live, p: Json): Promise<void> {
  const { ctx } = s;
  const text = String(p.text ?? "").trim();
  const reply = (t: string) => respond(p.response_url, t);
  if (!text || /^help$/i.test(text)) { await reply("`/factory <what you want done>` starts a request. `/factory status` shows what the factory is doing. You can also mention me, DM me, or react to a message with the trigger emoji."); return; }
  if (/^status$/i.test(text)) { await reply(await statusText(ctx)); return; }
  const request = slackToText(text, () => undefined, s.botUser);
  // The request needs a message of its own to hang its thread on: in the channel if the bot can
  // post there, else the status channel, else the person's DM with the app.
  let at: { channel: string; ts: string } | null = null;
  for (const target of [String(p.channel_id ?? ""), cfgStr(ctx.config.statusChannel), String(p.user_id ?? "")].filter(Boolean)) {
    try {
      const r = await slack<{ channel: string; ts: string }>(ctx.secrets.botToken, "chat.postMessage", { channel: target, text: `<@${p.user_id}> asked: ${toMrkdwn(request)}`, unfurl_links: false });
      at = { channel: r.channel, ts: r.ts };
      break;
    } catch (e) {
      if (!(e instanceof SlackError) || !["not_in_channel", "channel_not_found", "is_archived", "restricted_action", "cannot_dm_bot"].includes(e.code)) throw e;
    }
  }
  if (!at) { await reply("I have nowhere to keep a thread for this: invite me to the channel (/invite @factory) or set a status channel on the source."); return; }
  const r = await intake(s, { channel: at.channel, ts: at.ts, user: String(p.user_id), team: p.team_id ?? s.team, text: request, react: false, via: "/factory" });
  await reply(r ? `Taken: <${itemLink(r.item.id)}|#${r.item.id}> ${toMrkdwn(r.item.title)}. I will keep you posted in the thread.` : "That did not make a request.");
}

async function onAction(s: Live, p: Json): Promise<void> {
  const { ctx } = s;
  const action = Array.isArray(p.actions) ? (p.actions[0] as Json | undefined) : undefined;
  if (!action || typeof action.value !== "string") return; // link buttons carry no value; Slack opens the URL itself
  if (!/^(approve|reject|review-approve)(-\d+)?$/.test(String(action.action_id ?? ""))) return;
  const m = /^(approve|reject|review-approve):(\d+)$/.exec(action.value);
  if (!m) return;
  const userId = String(p.user?.id ?? "");
  // A Slack Connect channel has people from other workspaces in it; they do not get to decide.
  if (s.team && p.user?.team_id && p.user.team_id !== s.team) { await respond(p.response_url, "Only people in this workspace can decide."); return; }
  const who = { via: "slack", name: await userName(ctx, userId) };
  // The member id and the username, never the display name: anyone can rename themselves to an approver's name.
  if (!mayDecide(ctx, userId, p.user?.username)) { await respond(p.response_url, `${who.name} is not on this source's approvers list.`); return; }
  const id = Number(m[2]);
  let verdict: string;
  try {
    if (m[1] === "review-approve") {
      await reviewDecision(id, "approved", `approved in Slack by ${who.name}`, { ...who, externalId: `action:${p.container?.message_ts ?? action.action_ts}:${userId}` });
      verdict = ":white_check_mark: Approved";
    } else {
      const a = await decide(id, m[1] === "approve" ? "approved" : "rejected", who);
      verdict = m[1] === "approve" ? `:white_check_mark: ${a.kind} approved` : `:x: ${a.kind} declined`;
    }
  } catch (e) {
    await respond(p.response_url, `Could not do that: ${errText(e)}`);
    return;
  }
  ctx.log(`${verdict.replace(/:\w+: /, "")} by ${who.name} (button)`);
  // Replace the buttons with who decided; keep the text of the post.
  const channel = p.container?.channel_id ?? p.channel?.id, ts = p.container?.message_ts ?? p.message?.ts;
  if (!channel || !ts) return;
  const kept = (Array.isArray(p.message?.blocks) ? (p.message.blocks as Json[]) : []).filter((b) => b?.type !== "actions");
  await slack(ctx.secrets.botToken, "chat.update", { channel, ts, text: p.message?.text ?? verdict, blocks: [...kept, { type: "context", elements: [{ type: "mrkdwn", text: `${verdict} by <@${userId}>` }] }] })
    .catch((e) => ctx.log(`could not update the post after the decision: ${errText(e)}`, "warn"));
}

// Problems only a person can fix (the tokens, the app's settings), so the connection stops and says why.
// Anything else (Slack's internal_error, fatal_error despite its name, service_unavailable, request_timeout, ratelimited, a network error) is retried with backoff.
const FATAL = new Set([
  "invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "invalid_app", "missing_scope", "not_allowed_token_type",
  "no_permission", "ekm_access_denied", "team_access_not_granted", "two_factor_setup_required",
]);

async function startSocket(ctx: SourceContext): Promise<() => Promise<void>> {
  const appToken = ctx.secrets.appToken ?? "", botToken = ctx.secrets.botToken ?? "";
  if (!appToken.startsWith("xapp-")) throw new Error("the app-level token (xapp-…) is missing or is not an app-level token");
  if (!botToken.startsWith("xoxb-")) throw new Error("the bot token (xoxb-…) is missing or is not a bot token");
  const ctrl = new AbortController();
  const seenIds = new Map<string, true>();
  const channels = new Set(cfgList(String(ctx.config.channels ?? "").replace(/\s+/g, ",")));
  const saved = ctx.source.cursor?.lastTs && typeof ctx.source.cursor.lastTs === "object" ? (ctx.source.cursor.lastTs as Record<string, unknown>) : {};
  const lastTs = new Map(Object.entries(saved).filter((kv): kv is [string, string] => channels.has(kv[0]) && typeof kv[1] === "string"));
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    await ctx.saveCursor({ ...(ctx.source.cursor ?? {}), lastTs: Object.fromEntries(lastTs) }).catch((e) => ctx.log(`could not save how far the channels were read: ${errText(e)}`, "warn"));
  };
  const s: Live = {
    ctx, botUser: null, team: null, channels,
    emoji: new Set([(cfgStr(ctx.config.emoji, "factory") || "factory").replace(/:/g, ""), "robot_face"]),
    requireMention: cfgBool(ctx.config.requireMention, true),
    seen: (id) => {
      if (seenIds.has(id)) return true;
      seenIds.set(id, true);
      if (seenIds.size > 2000) seenIds.delete(seenIds.keys().next().value!);
      return false;
    },
    lastTs,
    noteTs: (channel, ts) => {
      if (!channels.has(channel)) return;
      const cur = lastTs.get(channel);
      if (cur && cmpTs(ts, cur) <= 0) return;
      lastTs.set(channel, ts);
      // Saved within seconds rather than per message: a busy channel would otherwise write the database on every message.
      if (!saveTimer) { saveTimer = setTimeout(() => void flush(), 10_000); saveTimer.unref?.(); }
    },
    stopped: () => ctrl.signal.aborted,
  };
  // Who the bot is (to ignore its own messages), and a first socket URL. A refusal of either token
  // is a configuration problem and is shown on the source; anything else is left to the loop.
  const whoami = async () => { const r = await slack<{ user_id: string; team_id: string }>(botToken, "auth.test"); s.botUser = r.user_id; s.team = r.team_id; };
  let firstUrl: string | null = null;
  try {
    await whoami();
    firstUrl = (await slack<{ url: string }>(appToken, "apps.connections.open")).url;
  } catch (e) {
    if (e instanceof SlackError && FATAL.has(e.code)) throw e;
    ctx.log(`could not reach Slack, will retry: ${errText(e)}`, "warn");
  }

  let ws: WebSocket | null = null;
  /** Connections being replaced: they keep delivering until the next one says hello. */
  const retiring = new Set<WebSocket>();
  let catchingUp = false, again = false;
  const catchUp = () => {
    if (!channels.size) return;
    if (catchingUp) { again = true; return; }
    catchingUp = true;
    void backfill(s).catch((e) => ctx.log(`catching up: ${errText(e)}`, "warn")).finally(() => {
      catchingUp = false;
      void flush();
      if (again && !ctrl.signal.aborted) { again = false; catchUp(); }
    });
  };

  const dispatch = async (env: Json) => {
    if (env.type === "events_api") return onEvent(s, env.payload ?? {});
    if (env.type === "slash_commands") return onCommand(s, env.payload ?? {});
    if (env.type === "interactive" && env.payload?.type === "block_actions") return onAction(s, env.payload);
  };

  type Outcome = "ok" | "failed" | "disabled" | "handover";
  /** One connection: until it closes ("ok" if Slack said hello first), or until it is to be replaced ("handover": the next one opens now, and its hello closes this one). */
  const connectOnce = (url: string) => new Promise<Outcome>((resolve) => {
    const sock = new WebSocket(url);
    ws = sock;
    let outcome: Outcome = "failed";
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const noHello = setTimeout(() => sock.close(), 30_000);
    const retire = () => {
      clearTimeout(refresh);
      if (outcome !== "ok") { sock.close(); return; } // never connected properly: nothing worth keeping open
      if (retiring.has(sock)) return;
      retiring.add(sock);
      setTimeout(() => { try { sock.close(); } catch { /* closed */ } }, 15_000).unref?.(); // in case no replacement says hello
      resolve("handover");
    };
    sock.addEventListener("message", (ev) => {
      let msg: Json;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "hello") {
        outcome = "ok";
        clearTimeout(noHello);
        for (const old of retiring) if (old !== sock) { try { old.close(); } catch { /* closed */ } }
        // Node's WebSocket hides pings, so a half-open link is invisible; hand over to a fresh connection before Slack's own refresh instead.
        const secs = Number(msg.debug_info?.approximate_connection_time ?? 3600);
        refresh = setTimeout(retire, Math.max(60, secs - 30) * 1000);
        ctx.saveState({ connected: true, since: new Date().toISOString() }).catch(() => {});
        if (ctx.source.last_error) ctx.setError(null).catch(() => {});
        catchUp();
        return;
      }
      if (msg.type === "disconnect") {
        // "warning" comes about 10 s before Slack closes this connection, "refresh_requested" just before: open the next one first so nothing falls in between.
        if (msg.reason === "warning" || msg.reason === "refresh_requested") { retire(); return; }
        if (msg.reason === "link_disabled") outcome = "disabled";
        sock.close();
        return;
      }
      if (typeof msg.envelope_id !== "string") return;
      // Ack first (Slack wants it within about 3 s, or it retries and the user sees an error), then work.
      try { sock.send(JSON.stringify({ envelope_id: msg.envelope_id })); } catch { /* closing; Slack will redeliver */ }
      void dispatch(msg).catch((e) => ctx.log(`${msg.type}: ${errText(e)}`, "warn"));
    });
    sock.addEventListener("close", () => { clearTimeout(noHello); clearTimeout(refresh); retiring.delete(sock); if (ws === sock) ws = null; resolve(outcome); });
    sock.addEventListener("error", () => { /* a close event follows */ });
  });

  const loop = (async () => {
    let failures = 0;
    while (!ctrl.signal.aborted) {
      let why = "", handover = false;
      try {
        if (!s.botUser) await whoami();
        const url = firstUrl ?? (await slack<{ url: string }>(appToken, "apps.connections.open")).url; // every connection needs a fresh URL
        firstUrl = null;
        if (ctrl.signal.aborted) break;
        const outcome = await connectOnce(url);
        handover = outcome === "handover";
        if (outcome === "disabled") {
          why = "Socket Mode is turned off for this Slack app; turn it on in the app settings";
          ctx.log(why, "error");
          await ctx.setError(why).catch(() => {});
        } else if (outcome === "failed") why = "the connection closed before Slack said hello";
        failures = outcome === "ok" || handover ? 0 : failures + 1;
      } catch (e) {
        failures++;
        if (e instanceof SlackError && FATAL.has(e.code)) {
          const msg = `${errText(e)}: fix the tokens or the app's settings on this source; not reconnecting`;
          ctx.log(msg, "error");
          await ctx.saveState({ connected: false, error: errText(e) }).catch(() => {});
          await ctx.setError(msg).catch(() => {});
          return;
        }
        why = errText(e);
        if (failures === 1 || failures % 10 === 0) ctx.log(`could not connect (attempt ${failures}): ${why}`, "warn");
      }
      if (handover) continue; // the next connection opens now, while this one still delivers
      if (failures) {
        await ctx.saveState({ connected: false, failures, at: new Date().toISOString() }).catch(() => {});
        // A few in a row are worth showing on the source; the next hello clears it.
        if (failures >= 3 && why) await ctx.setError(`could not connect to Slack (${failures} attempts in a row): ${why}`).catch(() => {});
      }
      if (!ctrl.signal.aborted) await sleep(Math.min(60_000, 500 * 2 ** failures) * (0.5 + Math.random()), ctrl.signal);
    }
  })();

  return async () => {
    ctrl.abort();
    for (const sock of [ws as WebSocket | null, ...retiring]) { try { sock?.close(); } catch { /* already closed */ } }
    await Promise.race([loop, sleep(5000)]);
    await flush();
    await ctx.saveState({ connected: false, at: new Date().toISOString() }).catch(() => {});
  };
}

const adapter: SourceAdapter = {
  kind: "slack",
  label: "Slack",
  description: "Requests from Slack over Socket Mode (no public URL): mention the bot, DM it, react with the trigger emoji, or use /factory. Progress is posted in the thread, with Approve/Reject buttons; replies in the thread are feedback.",
  help: HELP,
  defaultIntervalSec: null,
  fields: [
    { key: "approvers", label: "Who may approve", placeholder: "U0123ABCD, priya", help: "Slack member ids (U…: the person's profile → ⋮ → Copy member ID) or usernames, comma-separated. Buttons match either; replies in a thread match the member id only, so ids are safer. Display names never count. Empty: anyone in this workspace." },
    { key: "appToken", label: "App-level token", secret: true, required: true, placeholder: "xapp-…", help: "Basic Information → App-Level Tokens, scope connections:write." },
    { key: "botToken", label: "Bot token", secret: true, required: true, placeholder: "xoxb-…", help: "Install App → Bot User OAuth Token." },
    { key: "channels", label: "Trigger channels", placeholder: "C0123ABCD, C0456EFGH", help: "Channel ids where mentions and the emoji start requests. Empty: anywhere the bot has been invited. DMs and /factory always work. Listed channels are also read back after a restart or a dropped connection, so requests made meanwhile are not lost." },
    { key: "emoji", label: "Trigger emoji", placeholder: "factory", default: "factory", help: "Reacting with this (or :robot_face:) to a message makes it a request. Without colons." },
    { key: "requireMention", label: "Require a mention", kind: "boolean", default: true, help: "Off: every new top-level message in the trigger channels becomes a request (only there, never everywhere)." },
    { key: "statusChannel", label: "Status channel", placeholder: "C0789IJKL", help: "Where /factory requests get their thread when the bot cannot post where the command was typed." },
  ],
  start: startSocket,
  async post(ctx, item, msg) {
    const o = item.origin as SlackOrigin;
    if (!o?.channel || !o.ts) return;
    const { text, blocks } = postBlocks(msg);
    const r = await slack<{ channel: string; ts: string }>(ctx.secrets.botToken, "chat.postMessage", { channel: o.channel, thread_ts: o.thread_ts ?? o.ts, text, blocks, unfurl_links: false, unfurl_media: false });
    if (item.status === "done") await react(ctx, o.channel, o.ts, "white_check_mark");
    else if (item.status === "failed") await react(ctx, o.channel, o.ts, "x");
    return { ref: { channel: r.channel, ts: r.ts } };
  },
  async test(ctx) {
    try {
      const a = await slack<{ user?: string; team?: string; url?: string }>(ctx.secrets.botToken, "auth.test");
      await slack(ctx.secrets.appToken, "apps.connections.open");
      return { ok: true, detail: `bot @${a.user} in ${a.team} (${a.url}); the app-level token can open a Socket Mode connection` };
    } catch (e) {
      return { ok: false, detail: errText(e) };
    }
  },
};

adapter.broadcast = async (ctx, text) => {
  const channel = cfgStr(ctx.config.statusChannel);
  if (!channel) return false;
  await slack(ctx.secrets.botToken, "chat.postMessage", { channel, text: toMrkdwn(text), unfurl_links: false });
  return true;
};

export function register(): void { registerSource(adapter); }
