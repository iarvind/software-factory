// Linear: a GraphQL poll (personal API key, no SDK) for issues with the trigger label, optionally
// in one team and some states. Each becomes a request; progress goes back as comments; new
// comments on an open item's issue are feedback or, while the factory waits, "approve"/"reject".
// A closed item's issue that is given the label again or moved back into the trigger states
// becomes a new request.
import { q } from "../../db.ts";
import { OPEN, type Item, type ItemDraft } from "../items.ts";
import type { PostMessage } from "../conversations.ts";
import { registerSource, type SourceAdapter, type SourceContext } from "./index.ts";
import { cfgList, cfgStr, chunks, errText, fetchRetry, FetchError, handleDecisionComment, markdownComment, nextExternalId, readJson } from "./util.ts";

const API = "https://api.linear.app/graphql";

type Conn<T> = { nodes?: T[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
type LinearUser = { id: string; name?: string; displayName?: string; email?: string | null };
export type LinearIssue = {
  id: string; identifier: string; title?: string; description?: string | null; url?: string; priority?: number | null; updatedAt?: string;
  creator?: LinearUser | null; team?: { key?: string } | null; state?: { name?: string; type?: string } | null; labels?: Conn<{ id?: string; name?: string }> | null;
};
/** One change in an issue's history: who, when, labels added, and the state it moved from and to. */
export type LinearHistory = { createdAt: string; actor?: { id: string } | null; addedLabelIds?: string[] | null; fromStateId?: string | null; toStateId?: string | null };
type LinearComment = { id: string; body?: string | null; createdAt: string; user?: LinearUser | null; issue?: { id: string } | null };

const ISSUES = `query FactoryIssues($filter: IssueFilter, $after: String) {
  issues(first: 50, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes { id identifier title description url priority updatedAt creator { id name displayName } team { key } state { name type } labels(first: 20) { nodes { id name } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const COMMENTS = `query FactoryComments($filter: CommentFilter, $after: String) {
  comments(first: 50, after: $after, orderBy: createdAt, filter: $filter) {
    nodes { id body createdAt user { id name displayName email } issue { id } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const HISTORY = `query FactoryIssueHistory($id: String!, $after: String) {
  issue(id: $id) {
    team { states(first: 100) { nodes { id name type } } }
    history(first: 50, after: $after) { nodes { createdAt actor { id } addedLabelIds fromStateId toStateId } pageInfo { hasNextPage endCursor } }
  }
}`;

const FINISHED = ["completed", "canceled", "duplicate"];

/** Linear's 0 none, 1 urgent, 2 high, 3 medium, 4 low → the factory's 1 … 5 (none is the middle). */
export const linearPriority = (p: number | null | undefined): number => (typeof p === "number" && p >= 1 && p <= 4 ? p : 3);

/** The issue filter: the label (any case), then optionally the team, the states, and "updated since". Without states, finished issues are left out. */
export function linearFilter(o: { label: string; teamKey?: string; states?: string[]; since?: string | null }): Record<string, unknown> {
  const f: Record<string, unknown> = { labels: { some: { name: { eqIgnoreCase: o.label } } } };
  if (o.since) f.updatedAt = { gt: o.since };
  if (o.teamKey) f.team = { key: { eq: o.teamKey } };
  f.state = o.states?.length ? { name: { in: o.states } } : { type: { nin: FINISHED } };
  return f;
}

/**
 * The change that asked for an issue again after its request closed (`since`), if any: someone
 * other than the factory put a trigger label on, or moved it from a state outside the trigger
 * states into one (`inTrigger`). Any other update leaves the closed request closed.
 */
export function linearAskedAgain(history: LinearHistory[], o: { since: string; selfId: string; labelIds: string[]; inTrigger: (stateId: string) => boolean }): LinearHistory | null {
  const since = Date.parse(o.since);
  return history.filter((h) => Date.parse(h.createdAt) > since && h.actor?.id !== o.selfId
    && ((h.addedLabelIds ?? []).some((id) => o.labelIds.includes(id)) || Boolean(h.fromStateId && h.toStateId && !o.inTrigger(h.fromStateId) && o.inTrigger(h.toStateId))))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1) ?? null;
}

/** Personal API keys (lin_api_…) go bare; anything else (an OAuth access token) as a Bearer token. */
export function linearAuth(key: string): string {
  const k = key.trim().replace(/^Bearer\s+/i, "");
  return /^lin_api_/.test(k) ? k : `Bearer ${k}`;
}

export function linearIssueToDraft(issue: LinearIssue, triggerLabel = "factory"): ItemDraft {
  const labels = (issue.labels?.nodes ?? []).map((l) => l?.name ?? "").filter((n) => n && n.toLowerCase() !== triggerLabel.toLowerCase());
  return {
    title: `${issue.identifier}: ${issue.title?.trim() || "(no title)"}`,
    body: issue.description?.trim() || "(no description)", // already markdown
    externalId: issue.id, externalUrl: issue.url ?? null, priority: linearPriority(issue.priority), labels,
    origin: { kind: "linear", issueId: issue.id, identifier: issue.identifier }, requesterName: issue.creator?.displayName || issue.creator?.name || null,
  };
}

export const linearComment = (msg: PostMessage) => markdownComment(msg, { where: "in a comment" });

// --- the API -------------------------------------------------------------------------------

type Gql = <T>(query: string, variables?: Record<string, unknown>, label?: string) => Promise<T>;

function client(ctx: SourceContext): Gql {
  const key = (ctx.secrets.apiKey ?? "").trim();
  if (!key) throw new Error("no Linear API key configured");
  const auth = linearAuth(key);
  return async <T>(query: string, variables: Record<string, unknown> = {}, label = "query"): Promise<T> => {
    const res = await fetchRetry(API, {
      method: "POST", label: `linear ${label}`, idempotent: !/^\s*mutation\b/.test(query), accept: [400], // GraphQL errors come back as 400 with a body worth reading
      headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }),
    });
    const json = await readJson<{ data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> } | null>(res, `linear ${label}`);
    if (json?.errors?.length) {
      const limited = json.errors.some((e) => e.extensions?.code === "RATELIMITED");
      throw new FetchError(`linear ${label}${limited ? " (rate limited)" : ""}: ${json.errors.map((e) => e.message ?? "error").join("; ").slice(0, 300)}`, res.status);
    }
    if (!json?.data) throw new FetchError(`linear ${label}: no data (HTTP ${res.status})`, res.status);
    return json.data;
  };
}

const viewers = new Map<string, LinearUser>();
/** Who the key belongs to: its comments are the factory's own. */
async function viewer(ctx: SourceContext, gql: Gql): Promise<LinearUser> {
  const key = `${ctx.source.id}:${ctx.source.updated_at}`;
  const hit = viewers.get(key);
  if (hit) return hit;
  const d = await gql<{ viewer: LinearUser & { email?: string } }>("query FactoryViewer { viewer { id name displayName email } }", {}, "viewer");
  viewers.set(key, d.viewer);
  return d.viewer;
}

// A closed item whose issue was already looked at, by the issue's updated time: unchanged since, it has not been asked for again.
const settled = new Map<string, string>();

/** Whether a closed item's issue was asked for again since the item closed (see linearAskedAgain). */
async function reasked(ctx: SourceContext, gql: Gql, me: LinearUser, issue: LinearIssue, prior: Item, label: string, states: string[]): Promise<boolean> {
  const memo = `${ctx.source.id}:${prior.id}`;
  if (issue.updatedAt && settled.get(memo) === issue.updatedAt) return false;
  type H = { issue?: { team?: { states?: Conn<{ id: string; name?: string; type?: string }> } | null; history?: Conn<LinearHistory> } | null };
  const history: LinearHistory[] = [];
  const stateOf = new Map<string, { name?: string; type?: string }>();
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const d = await gql<H>(HISTORY, { id: issue.id, after }, "history");
    for (const st of d.issue?.team?.states?.nodes ?? []) stateOf.set(st.id, st);
    history.push(...(d.issue?.history?.nodes ?? []));
    const info = d.issue?.history?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  const inTrigger = (id: string) => { const st = stateOf.get(id); return Boolean(st) && (states.length ? states.includes(st!.name ?? "") : !FINISHED.includes(st!.type ?? "")); };
  const labelIds = (issue.labels?.nodes ?? []).filter((l) => l.id && l.name?.toLowerCase() === label.toLowerCase()).map((l) => l.id!);
  const hit = linearAskedAgain(history, { since: prior.finished_at ?? prior.updated_at, selfId: me.id, labelIds, inTrigger });
  if (!hit && issue.updatedAt) { settled.set(memo, issue.updatedAt); if (settled.size > 2000) settled.delete(settled.keys().next().value!); }
  return Boolean(hit);
}

/** An item's Linear issue id: later requests on the same issue have external ids `<id>#2`, `<id>#3`. */
const issueOf = (it: Item) => (it.origin as { issueId?: string }).issueId ?? (it.external_id ?? "").split("#")[0];

type Cursor = { since: string | null; commentsSince: string | null; recent: string[] };
function readCursor(raw: Record<string, unknown> | null | undefined): Cursor {
  const c = raw ?? {};
  return { since: typeof c.since === "string" ? c.since : null, commentsSince: typeof c.commentsSince === "string" ? c.commentsSince : null, recent: Array.isArray(c.recent) ? c.recent.map(String) : [] };
}

async function* paged<T>(gql: Gql, query: string, filter: Record<string, unknown>, field: "issues" | "comments"): AsyncGenerator<T> {
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const d = await gql<Record<string, Conn<T> | undefined>>(query, { filter, after }, field);
    for (const n of d[field]?.nodes ?? []) if (n) yield n;
    const info = d[field]?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) return;
    after = info.endCursor;
  }
}

const adapter: SourceAdapter = {
  kind: "linear",
  label: "Linear",
  description: "Polls Linear for issues with the trigger label (optionally one team, some states). Each becomes a request; progress is commented on the issue; comments are feedback, and \"approve\"/\"reject\" decide while the factory waits.",
  help: `Create a personal API key under Settings → Security & access → Personal API keys, ideally as a bot member of the workspace: the factory comments as that user. An OAuth access token works too. Team key is the prefix of issue ids (ENG in ENG-123).`,
  defaultIntervalSec: 60,
  fields: [
    { key: "approvers", label: "Who may approve", placeholder: "priya@yourteam.com, sam@yourteam.com", help: "Linear email addresses or user ids, comma-separated. Display names never count. Empty: anyone who can comment on the issue." },
    { key: "apiKey", label: "API key", secret: true, required: true, placeholder: "lin_api_…", help: "A personal API key (lin_api_…), or an OAuth access token (sent as a Bearer token)." },
    { key: "teamKey", label: "Team key", placeholder: "ENG", help: "Optional: only this team's issues." },
    { key: "label", label: "Trigger label", default: "factory", placeholder: "factory" },
    { key: "states", label: "States", placeholder: "Todo, Backlog", help: "Optional: only issues in these workflow states (by name). Empty: any state that is not completed or canceled." },
  ],
  async poll(ctx) {
    const gql = client(ctx);
    const me = await viewer(ctx, gql);
    const c = readCursor(ctx.source.cursor);
    const label = cfgStr(ctx.config.label) || "factory";

    // 1. Labelled issues updated since the last poll. The sort direction is not documented, so keep the max ourselves.
    let since = c.since;
    const states = cfgList(ctx.config.states);
    const filter = linearFilter({ label, teamKey: cfgStr(ctx.config.teamKey) || undefined, states, since: c.since });
    for await (const issue of paged<LinearIssue>(gql, ISSUES, filter, "issues")) {
      if (issue.updatedAt && (!since || issue.updatedAt > since)) since = issue.updatedAt;
      try {
        const prior = await ctx.latestItem(issue.id);
        if (prior && OPEN.includes(prior.status)) continue; // its comments are read below
        // A closed request stays closed while its issue is merely updated (the factory's last comment, for one).
        if (prior && !(await reasked(ctx, gql, me, issue, prior, label, states))) continue;
        const draft = linearIssueToDraft(issue, label);
        if (prior) { draft.externalId = nextExternalId(issue.id, prior.external_id); draft.body = `${draft.body}\n\nAsked for again after #${prior.id} (${prior.status}).`; }
        const r = await ctx.createItem(draft);
        if (!r.created) continue;
        ctx.log(`#${r.item.id} from ${issue.identifier}${prior ? ` (asked again after #${prior.id})` : ""}`);
        if (prior) await adapter.post!(ctx, r.item, { text: `#${prior.id} for this issue is ${prior.status}, so I took this as a new request, #${r.item.id}, linked to #${prior.id}.` }).catch((e) => ctx.log(`${issue.identifier}: could not comment: ${errText(e)}`, "warn"));
      } catch (e) { ctx.log(`${issue.identifier}: ${errText(e)}`, "warn"); }
    }
    c.since = since;

    // 2. New comments on the issues of open items, wherever those issues are now.
    const open = await q<Item>("select * from work_items where source_id = $1 and status = any($2) and external_id is not null", [ctx.source.id, OPEN]);
    const start = c.commentsSince ?? new Date().toISOString(); // first poll: from now (earlier comments are context, not feedback)
    let commentsSince = start;
    const recent = new Set(c.recent);
    const byIssue = new Map(open.map((it) => [issueOf(it), it]));
    const overlap = new Date(Date.parse(start) - 60_000).toISOString();
    for (const ids of chunks([...byIssue.keys()], 50)) {
      for await (const cm of paged<LinearComment>(gql, COMMENTS, { createdAt: { gt: overlap }, issue: { id: { in: ids } } }, "comments")) {
        if (cm.createdAt > commentsSince) commentsSince = cm.createdAt;
        if (recent.has(cm.id)) continue;
        recent.add(cm.id);
        const item = byIssue.get(cm.issue?.id ?? "");
        // No user: an integration's comment. Our own key's comments are ours.
        if (!item || !cm.user || cm.user.id === me.id || !cm.body?.trim()) continue;
        if (Date.parse(cm.createdAt) < Date.parse(item.created_at)) continue;
        try {
          await handleDecisionComment(ctx, item, cm.body, cm.user.displayName || cm.user.name || null, `comment:${cm.id}`, { createdAt: cm.createdAt, identities: [cm.user.id, cm.user.email], reply: (t) => adapter.post!(ctx, item, { text: t }) });
        } catch (e) { ctx.log(`comment ${cm.id}: ${errText(e)}`, "warn"); }
      }
    }
    // With nothing open there is nothing to read; move the mark so a later item does not page through history.
    c.commentsSince = open.length ? commentsSince : new Date(Date.now() - 60_000).toISOString();
    c.recent = [...recent].slice(-300);
    await ctx.saveCursor(c);
  },
  async post(ctx, item, msg) {
    const o = item.origin as { kind: "linear"; issueId?: string };
    if (!o?.issueId) return;
    const gql = client(ctx);
    const d = await gql<{ commentCreate?: { success?: boolean; comment?: { id: string; url?: string } } }>(
      "mutation FactoryComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }",
      { input: { issueId: o.issueId, body: linearComment(msg) } }, "commentCreate");
    if (!d.commentCreate?.success) throw new Error("linear commentCreate did not succeed");
    return { ref: { issueId: o.issueId, commentId: d.commentCreate.comment?.id ?? null, url: d.commentCreate.comment?.url ?? null } };
  },
  async test(ctx) {
    try {
      const gql = client(ctx);
      const d = await gql<{ viewer: { name?: string; email?: string } }>("query FactoryViewer { viewer { id name email } }", {}, "viewer");
      const teamKey = cfgStr(ctx.config.teamKey);
      if (!teamKey) return { ok: true, detail: `signed in as ${d.viewer.name}${d.viewer.email ? ` (${d.viewer.email})` : ""}` };
      const t = await gql<{ teams: Conn<{ name?: string }> }>("query FactoryTeam($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id name } } }", { key: teamKey }, "teams");
      const team = t.teams?.nodes?.[0];
      return team ? { ok: true, detail: `signed in as ${d.viewer.name}; team ${team.name} (${teamKey})` } : { ok: false, detail: `signed in as ${d.viewer.name}, but there is no team with the key ${teamKey}` };
    } catch (e) {
      return { ok: false, detail: errText(e) };
    }
  },
};

export function register(): void { registerSource(adapter); }
