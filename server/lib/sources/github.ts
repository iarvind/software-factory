// GitHub issues: a poll of the repository's open issues with the trigger label. A labelled issue
// becomes a request (a 👀 reaction says it was seen); progress goes back as comments; new
// comments are feedback or, while the factory waits, "approve"/"reject". With a token this is
// REST with ETags (an unchanged answer is a free 304); without one it goes through the `gh` CLI
// this Mac is logged in to. Pull requests are watched elsewhere (prwatch.ts). A closed item's
// issue that is reopened or labelled again becomes a new request.
import { run } from "../exec.ts";
import { OPEN, type Item, type ItemDraft } from "../items.ts";
import { itemLink, type PostMessage } from "../conversations.ts";
import { registerSource, type SourceAdapter, type SourceContext } from "./index.ts";
import { cfgBool, cfgStr, errText, fetchRetry, FetchError, handleDecisionComment, isDecision, markdownComment, nextExternalId, readJson } from "./util.ts";

const API_VERSION = "2022-11-28";
/** Hidden in every comment the factory posts, so it never reads its own words back as feedback. */
export const MARKER = "<!-- software-factory -->";
// Comment authors whose word counts. Others (anyone, on a public repository) are ignored unless the source says otherwise.
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// What the collaborator permission API must say for someone whose association hides it (a private org member shows as CONTRIBUTOR or NONE).
const WRITE = new Set(["admin", "maintain", "write"]);

type GhUser = { login?: string; type?: string };
export type GhIssue = {
  number: number; title?: string; body?: string | null; html_url?: string; updated_at?: string; state?: string;
  user?: GhUser | null; labels?: Array<string | { name?: string }>; pull_request?: unknown; author_association?: string;
};
export type GhComment = { id: number; body?: string | null; user?: GhUser | null; created_at?: string; updated_at?: string; issue_url?: string; author_association?: string };
export type GhEvent = { event?: string; actor?: GhUser | null; label?: { name?: string }; created_at?: string };

/** An issue's external id. With the repository in it, pointing the source at another repository cannot match the old one's issue numbers. */
export const issueRef = (repo: string, n: number) => `${repo}#${n}`;

/** The event that asked for an issue again after its request closed (`since`): the trigger label put back on, or the issue reopened, by someone other than the factory. */
export function retrigger(events: GhEvent[], label: string, since: string, me: string): GhEvent | null {
  const t = Date.parse(since);
  return events.filter((e) => (e.event === "reopened" || (e.event === "labeled" && e.label?.name?.toLowerCase() === label.toLowerCase()))
    && Date.parse(e.created_at ?? "") > t && !(me && e.actor?.login === me)).at(-1) ?? null;
}

/** A labelled issue → the request. Earlier comments go into the body; only later ones become feedback. */
export function githubIssueToDraft(issue: GhIssue, repo: string, triggerLabel = "factory", comments: GhComment[] = []): ItemDraft {
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name ?? "")).filter((l) => l && l.toLowerCase() !== triggerLabel.toLowerCase());
  const said = comments.filter((c) => !(c.body ?? "").includes(MARKER)).slice(-20).map((c) => `- ${c.user?.login ?? "someone"}: ${(c.body ?? "").replace(/\s+/g, " ").trim().slice(0, 800)}`);
  return {
    title: issue.title?.trim() || `${repo}#${issue.number}`,
    body: [issue.body?.trim() || "(no description)", said.length ? `Comments on ${repo}#${issue.number}:\n${said.join("\n")}` : ""].filter(Boolean).join("\n\n"),
    externalId: issueRef(repo, issue.number), externalUrl: issue.html_url ?? `https://github.com/${repo}/issues/${issue.number}`,
    labels, origin: { kind: "github", repo, issue: issue.number }, requesterName: issue.user?.login ?? null,
  };
}

/** The comment the factory posts: markdown, "#12" linked to the factory's item 12, and what to reply in place of buttons. */
export function githubComment(msg: PostMessage, itemId: number, link = itemLink(itemId)): string {
  return markdownComment(msg, { where: "to this issue", marker: MARKER, link: { id: itemId, url: link } });
}

export function parseRepo(raw: string): string {
  const repo = raw.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${raw}" is not owner/name`);
  return repo;
}

// --- the API: a token, or the gh CLI ---------------------------------------------------------

type Got<T> = { status: number; data: T; etag: string | null };
type Client = { repo: string; viaGh: boolean; call: <T>(method: string, path: string, body?: unknown, etag?: string | null) => Promise<Got<T>> };

function client(ctx: SourceContext): Client {
  const repo = parseRepo(cfgStr(ctx.config.repo));
  const token = (ctx.secrets.token ?? "").trim();
  const label = (method: string, path: string) => `github ${method} ${path.split("?")[0]}`;
  if (token) {
    return {
      repo, viaGh: false,
      async call<T>(method: string, path: string, body?: unknown, etag?: string | null): Promise<Got<T>> {
        const res = await fetchRetry(`https://api.github.com${path}`, {
          method, label: label(method, path), accept: [304],
          headers: {
            Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION, "User-Agent": "software-factory",
            ...(etag ? { "If-None-Match": etag } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 304) { await res.body?.cancel().catch(() => {}); return { status: 304, data: null as T, etag: etag ?? null }; }
        return { status: res.status, data: res.status === 204 ? (null as T) : await readJson<T>(res, label(method, path)), etag: res.headers.get("etag") };
      },
    };
  }
  return {
    repo, viaGh: true,
    // gh keeps its own login (keyring or GH_TOKEN); no ETags this way, which a 60 s poll can afford.
    async call<T>(method: string, path: string, body?: unknown): Promise<Got<T>> {
      const args = ["api", path.replace(/^\//, ""), "--method", method, "-H", "Accept: application/vnd.github+json", "-H", `X-GitHub-Api-Version: ${API_VERSION}`];
      if (body !== undefined) args.push("--input", "-");
      const r = await run("gh", args, { timeoutMs: 30_000, input: body === undefined ? undefined : JSON.stringify(body) });
      if (r.timedOut) throw new Error(`gh api ${method} ${path.split("?")[0]}: no answer in 30 s`);
      if (r.code !== 0) throw new Error(`gh api ${method} ${path.split("?")[0]} failed (${r.code ?? "not run"}): ${(r.stderr || r.stdout).replace(/\s+/g, " ").trim().slice(0, 400)}`);
      try { return { status: 200, data: (r.stdout.trim() ? JSON.parse(r.stdout) : null) as T, etag: null }; }
      catch { throw new Error(`gh api ${method} ${path.split("?")[0]}: not JSON: ${r.stdout.slice(0, 200)}`); }
    },
  };
}

const logins = new Map<string, string>();
/** Who the factory is on GitHub, to skip its own comments (the marker catches them too). */
async function myLogin(ctx: SourceContext, gh: Client): Promise<string> {
  const key = `${ctx.source.id}:${ctx.source.updated_at}`;
  const hit = logins.get(key);
  if (hit !== undefined) return hit;
  try {
    const r = await gh.call<GhUser>("GET", "/user");
    const login = r.data?.login ?? "";
    logins.set(key, login);
    return login;
  } catch (e) {
    ctx.log(`could not tell who the token belongs to (GET /user): ${errText(e)}`, "warn");
    return "";
  }
}

const access = new Map<string, boolean>();
/** Whether a login can write to the repository, by the collaborator permission API. Cached for the life of the process; a failed lookup is not an answer and is not cached. */
async function canWrite(gh: Client, login: string): Promise<boolean> {
  const key = `${gh.repo}:${login.toLowerCase()}`;
  const hit = access.get(key);
  if (hit !== undefined) return hit;
  try {
    const r = await gh.call<{ permission?: string; role_name?: string } | null>("GET", `/repos/${gh.repo}/collaborators/${encodeURIComponent(login)}/permission`);
    // `permission` folds maintain into write and triage into read; `role_name` has the real role.
    const ok = WRITE.has(r.data?.permission ?? "") || WRITE.has(r.data?.role_name ?? "");
    access.set(key, ok);
    return ok;
  } catch (e) {
    if (e instanceof FetchError && e.status === 404) access.set(key, false); // no such user, or not a collaborator
    return false;
  }
}

/** A trusted person: owner, member or collaborator by association, else write access by the permission API. */
async function trusted(gh: Client, login: string | null | undefined, association: string | undefined): Promise<boolean> {
  if (TRUSTED.has(association ?? "")) return true;
  return Boolean(login) && canWrite(gh, login!);
}

/** The issue's events, oldest first, up to 500 (enough for any issue a factory works on). */
async function issueEvents(gh: Client, n: number): Promise<GhEvent[]> {
  const out: GhEvent[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await gh.call<GhEvent[] | null>("GET", `/repos/${gh.repo}/issues/${n}/events?per_page=100&page=${page}`);
    const list = Array.isArray(r.data) ? r.data : [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

/** Whether a person who may decide did it: a trusted author, or someone else (only triage+ can label or reopen other people's issues). Issue templates can apply labels for anyone, so an outsider labelling their own issue does not count. */
async function byTrusted(gh: Client, issue: GhIssue, actor: string | null | undefined): Promise<boolean> {
  if (actor && actor !== issue.user?.login) return true;
  return trusted(gh, issue.user?.login, issue.author_association);
}

const lastLabelled = (events: GhEvent[], label: string) => events.filter((e) => e.event === "labeled" && e.label?.name?.toLowerCase() === label.toLowerCase()).at(-1)?.actor?.login;

/** The newest item for an issue. Items from before the external id carried the repository have the bare number; their origin says which repository. */
async function itemFor(ctx: SourceContext, repo: string, n: number): Promise<Item | null> {
  const it = await ctx.latestItem(issueRef(repo, n));
  if (it) return it;
  const legacy = await ctx.itemByExternalId(String(n));
  return legacy && (legacy.origin as { repo?: string }).repo === repo ? legacy : null;
}

// A closed item whose issue was already looked at, by the issue's updated time: unchanged since, it has not been asked for again.
const settled = new Map<string, string>();

type Cursor = {
  issuesSince: string | null; issuesEtag: { path: string; etag: string; count: number } | null;
  commentsSince: string | null; commentsEtag: { path: string; etag: string; count: number } | null;
  recent: number[]; refused: number[];
};
function readCursor(raw: Record<string, unknown> | null | undefined): Cursor {
  const c = (raw ?? {}) as Partial<Cursor>;
  const nums = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);
  const tag = (v: unknown) => (v && typeof v === "object" && typeof (v as { etag?: unknown }).etag === "string" ? (v as Cursor["issuesEtag"]) : null);
  return { issuesSince: typeof c.issuesSince === "string" ? c.issuesSince : null, issuesEtag: tag(c.issuesEtag), commentsSince: typeof c.commentsSince === "string" ? c.commentsSince : null, commentsEtag: tag(c.commentsEtag), recent: nums(c.recent), refused: nums(c.refused) };
}

/** Pages of a list endpoint, with the ETag on the first page (only trusted when that page was not full: a full one may hide changes further on). */
async function* pages<T>(gh: Client, base: string, etag: Cursor["issuesEtag"], setEtag: (e: Cursor["issuesEtag"]) => void): AsyncGenerator<T[]> {
  for (let page = 1; page <= 10; page++) {
    const path = `${base}&per_page=100&page=${page}`;
    const r = await gh.call<T[] | null>("GET", path, undefined, page === 1 && etag?.path === path && etag.count < 100 ? etag.etag : null);
    if (r.status === 304) return; // nothing changed since the last poll
    const list = Array.isArray(r.data) ? r.data : [];
    if (page === 1) setEtag(r.etag ? { path, etag: r.etag, count: list.length } : null);
    yield list;
    if (list.length < 100) return;
  }
}

async function takeIssue(ctx: SourceContext, gh: Client, issue: GhIssue, label: string, me: string, c: Cursor, trustedOnly: boolean): Promise<void> {
  const ref = issueRef(gh.repo, issue.number);
  const prior = await itemFor(ctx, gh.repo, issue.number);
  if (prior && OPEN.includes(prior.status)) return; // its comments are read below
  const refuse = (why: string) => {
    if (!c.refused.includes(issue.number)) { ctx.log(`${ref}: not taken; ${why}`, "warn"); c.refused = [...c.refused, issue.number].slice(-200); }
  };
  if (prior) {
    // A closed request stays closed while its issue is merely updated (the factory's last comment, for one).
    const memo = `${ctx.source.id}:${prior.id}`;
    if (issue.updated_at && settled.get(memo) === issue.updated_at) return;
    const ev = retrigger(await issueEvents(gh, issue.number), label, prior.finished_at ?? prior.updated_at, me);
    if (!ev) { if (issue.updated_at) { settled.set(memo, issue.updated_at); if (settled.size > 2000) settled.delete(settled.keys().next().value!); } return; }
    if (trustedOnly && !(await byTrusted(gh, issue, ev.actor?.login))) return refuse(`it was ${ev.event === "reopened" ? "reopened" : `labelled "${label}" again`} by someone who is not a collaborator`);
  } else if (trustedOnly && !TRUSTED.has(issue.author_association ?? "") && !(await byTrusted(gh, issue, lastLabelled(await issueEvents(gh, issue.number), label)))) {
    return refuse(`the "${label}" label was not put on by a collaborator`);
  }
  const comments = await gh.call<GhComment[]>("GET", `/repos/${gh.repo}/issues/${issue.number}/comments?per_page=50`).then((r) => r.data ?? []).catch(() => []);
  const draft = githubIssueToDraft(issue, gh.repo, label, comments.filter((x) => !me || x.user?.login !== me));
  if (prior) { draft.externalId = nextExternalId(ref, prior.external_id); draft.body = `${draft.body}\n\nAsked for again after #${prior.id} (${prior.status}).`; }
  const r = await ctx.createItem(draft);
  if (!r.created) return;
  ctx.log(`#${r.item.id} from ${ref}${prior ? ` (asked again after #${prior.id})` : ""}`);
  await gh.call("POST", `/repos/${gh.repo}/issues/${issue.number}/reactions`, { content: "eyes" }).catch((e) => ctx.log(`${ref}: could not react: ${errText(e)}`, "warn"));
  if (prior) await adapter.post!(ctx, r.item, { text: `#${prior.id} for this issue is ${prior.status}, so I took this as a new request, #${r.item.id}, linked to #${prior.id}.` }).catch((e) => ctx.log(`${ref}: could not comment: ${errText(e)}`, "warn"));
}

async function readComment(ctx: SourceContext, gh: Client, cm: GhComment, me: string, trustedOnly: boolean): Promise<void> {
  const n = Number(/\/issues\/(\d+)$/.exec(cm.issue_url ?? "")?.[1]);
  if (!n) return;
  const body = cm.body ?? "";
  if ((me && cm.user?.login === me) || body.includes(MARKER) || cm.user?.type === "Bot" || !body.trim()) return;
  const item = await itemFor(ctx, gh.repo, n);
  if (!item || !OPEN.includes(item.status)) return;
  if (cm.created_at && Date.parse(cm.created_at) < Date.parse(item.created_at)) return; // already in the request's body
  const author = cm.user?.login ?? null;
  // The permission lookup only when the answer matters: a comment that must come from a collaborator, or a verdict.
  const ok = TRUSTED.has(cm.author_association ?? "") || ((trustedOnly || isDecision(body)) && (await trusted(gh, author, cm.author_association)));
  if (trustedOnly && !ok) { ctx.log(`${gh.repo}#${n}: ignored a comment from ${author ?? "someone"}, who is not a collaborator`); return; }
  // Only a collaborator's "approve" decides anything, whatever the setting.
  if (!ok && isDecision(body)) { await ctx.feedback(item.id, { author, body, externalId: `comment:${cm.id}` }); return; }
  await handleDecisionComment(ctx, item, body, author, `comment:${cm.id}`, { createdAt: cm.created_at, identities: [author], reply: (t) => adapter.post!(ctx, item, { text: t }) });
}

const adapter: SourceAdapter = {
  kind: "github",
  label: "GitHub issues",
  description: "Polls a repository for open issues with the trigger label. Each becomes a request; progress is commented on the issue; collaborators' comments are feedback, and \"approve\"/\"reject\" decide while the factory waits.",
  help: `A fine-grained personal access token (github.com/settings/personal-access-tokens) for just this repository, with Issues: read and write (Metadata: read comes with it). Leave the token empty to use the gh CLI this Mac is logged in to (gh auth status). Only people with triage access can apply labels, so the label is the permission check.`,
  defaultIntervalSec: 60,
  fields: [
    { key: "approvers", label: "Who may approve", placeholder: "octocat, priya-s", help: "GitHub logins (as in github.com/<login>), comma-separated. Only collaborators' verdicts count in any case. Empty: any collaborator." },
    { key: "repo", label: "Repository", required: true, placeholder: "owner/name" },
    { key: "token", label: "Token", secret: true, placeholder: "github_pat_…", help: "Optional. Empty: use the gh CLI's login on this Mac." },
    { key: "label", label: "Trigger label", default: "factory", placeholder: "factory" },
    { key: "closeOnDone", label: "Close the issue when done", kind: "boolean", default: false },
    { key: "trustedOnly", label: "Only collaborators", kind: "boolean", default: true, help: "Take requests and comments only from the repository's owners, members and collaborators (and anyone with write access, which covers private organisation members). Turn off for a private repository where everyone is trusted." },
  ],
  async poll(ctx) {
    const gh = client(ctx);
    const me = await myLogin(ctx, gh);
    const label = cfgStr(ctx.config.label) || "factory";
    const trustedOnly = cfgBool(ctx.config.trustedOnly, true);
    const c = readCursor(ctx.source.cursor);

    // 1. Labelled open issues updated since the last poll (any new comment or label bumps updated_at).
    let issuesSince = c.issuesSince;
    const iq = new URLSearchParams({ labels: label, state: "open", sort: "updated", direction: "asc", ...(c.issuesSince ? { since: c.issuesSince } : {}) });
    for await (const list of pages<GhIssue>(gh, `/repos/${gh.repo}/issues?${iq}`, c.issuesEtag, (e) => { c.issuesEtag = e; })) {
      for (const issue of list) {
        if (issue.updated_at && (!issuesSince || issue.updated_at > issuesSince)) issuesSince = issue.updated_at;
        if (issue.pull_request || !issue.number) continue; // the issues endpoint lists pull requests too
        try { await takeIssue(ctx, gh, issue, label, me, c, trustedOnly); } catch (e) { ctx.log(`${gh.repo}#${issue.number}: ${errText(e)}`, "warn"); }
      }
    }
    c.issuesSince = issuesSince;

    // 2. Every comment in the repository since the last poll: one call covers the items whose
    // issue lost its label too. On the first poll, start now (earlier comments are in the bodies).
    const since = c.commentsSince ?? new Date().toISOString();
    let commentsSince = since;
    const recent = new Set(c.recent);
    const floor = Date.parse(since) - 2 * 60_000; // edits of old comments come back with a new updated_at; skip them
    const cq = new URLSearchParams({ since, sort: "updated", direction: "asc" });
    for await (const list of pages<GhComment>(gh, `/repos/${gh.repo}/issues/comments?${cq}`, c.commentsEtag, (e) => { c.commentsEtag = e; })) {
      for (const cm of list) {
        if (cm.updated_at && cm.updated_at > commentsSince) commentsSince = cm.updated_at;
        if (!cm.id || recent.has(cm.id) || (cm.created_at && Date.parse(cm.created_at) < floor)) continue;
        recent.add(cm.id);
        try { await readComment(ctx, gh, cm, me, trustedOnly); } catch (e) { ctx.log(`comment ${cm.id}: ${errText(e)}`, "warn"); }
      }
    }
    c.commentsSince = commentsSince;
    c.recent = [...recent].slice(-300);
    await ctx.saveCursor(c);
  },
  async post(ctx, item, msg) {
    const o = item.origin as { kind: "github"; repo?: string; issue?: number };
    if (!o?.repo || !o.issue) return;
    const gh = client(ctx);
    const r = await gh.call<{ id?: number; html_url?: string } | null>("POST", `/repos/${o.repo}/issues/${o.issue}/comments`, { body: githubComment(msg, item.id) });
    if (item.status === "done" && cfgBool(ctx.config.closeOnDone, false)) {
      await gh.call("PATCH", `/repos/${o.repo}/issues/${o.issue}`, { state: "closed", state_reason: "completed" }).catch((e) => ctx.log(`${o.repo}#${o.issue}: could not close: ${errText(e)}`, "warn"));
    }
    return { ref: { repo: o.repo, issue: o.issue, commentId: r.data?.id ?? null, url: r.data?.html_url ?? null } };
  },
  async test(ctx) {
    try {
      const gh = client(ctx);
      const r = await gh.call<{ full_name?: string; private?: boolean; has_issues?: boolean; permissions?: { push?: boolean; triage?: boolean } } | null>("GET", `/repos/${gh.repo}`);
      const d = r.data ?? {};
      const me = await myLogin(ctx, gh);
      const can = d.permissions ? (d.permissions.push ? "can push" : d.permissions.triage ? "can triage" : "read only") : "access unknown";
      return { ok: d.has_issues !== false, detail: `${d.full_name ?? gh.repo} (${d.private ? "private" : "public"}) through ${gh.viaGh ? "the gh CLI" : "the token"}${me ? ` as ${me}` : ""}; ${can}${d.has_issues === false ? "; issues are turned off for this repository" : ""}` };
    } catch (e) {
      return { ok: false, detail: errText(e) };
    }
  },
};

export function register(): void { registerSource(adapter); }
