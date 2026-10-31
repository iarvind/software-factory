// The pull request is where people and CI talk back. Every minute, each item in review with
// a pull request is read through `gh`: a merge or close ends the job, a review or comment
// becomes feedback (and, unless it is an approval, a fix round), a failed check is reported
// to the agent as something to fix. The factory's own comments are ignored.
import { q } from "../db.ts";
import { run } from "./exec.ts";
import { emit } from "./events.ts";
import { getItem, setStatus, type Item } from "./items.ts";
import { getProject } from "./projects.ts";
import { afterMerge, isActive, onComment, reviewDecision } from "./pipeline.ts";
import { postStatus } from "./conversations.ts";

let self: string | null | undefined;
async function ghLogin(): Promise<string | null> {
  if (self !== undefined) return self;
  const r = await run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 20000 });
  self = r.code === 0 ? r.stdout.trim() : null;
  return self;
}

type PrView = {
  state: "OPEN" | "CLOSED" | "MERGED"; mergedAt: string | null; reviewDecision: string | null; url: string;
  reviews: Array<{ id: string; author: { login: string }; authorAssociation?: string; state: string; body: string; submittedAt: string; commit?: { oid: string } }>;
  comments: Array<{ id: string; author: { login: string }; authorAssociation?: string; body: string; createdAt: string }>;
  statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string; status?: string; detailsUrl?: string; targetUrl?: string }>;
};

async function view(worktree: string, n: number): Promise<PrView | null> {
  const r = await run("gh", ["pr", "view", String(n), "--json", "state,mergedAt,reviewDecision,url,reviews,comments,statusCheckRollup"], { cwd: worktree, timeoutMs: 60000 });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout) as PrView; } catch { return null; }
}

/** Only people with a say in the repository steer the agent; a stranger's comment on a public repository is noise. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const trusted = (assoc: string | undefined) => Boolean(assoc) && TRUSTED.has(assoc!.toUpperCase());

async function inlineComments(worktree: string, repo: string, n: number): Promise<Array<{ id: number; user: { login: string }; author_association?: string; body: string; path: string; line: number | null; created_at: string }>> {
  const r = await run("gh", ["api", `repos/${repo}/pulls/${n}/comments`, "--paginate"], { cwd: worktree, timeoutMs: 60000 });
  if (r.code !== 0) return [];
  try { return JSON.parse(r.stdout); } catch { return []; }
}

export async function watchPullRequests(): Promise<void> {
  const items = await q<Item>("select * from work_items where status = 'review' and pr_number is not null and worktree is not null");
  for (const item of items) {
    if (isActive(item.id)) continue;
    try { await checkOne(item); } catch (e) { console.warn(`pr watch #${item.id}:`, e instanceof Error ? e.message : e); }
  }
}

async function checkOne(item: Item): Promise<void> {
  const p = await getProject(item.project_id);
  if (!p) return;
  const me = await ghLogin();
  const pr = await view(item.worktree!, item.pr_number!);
  if (!pr) return;
  const fresh = await getItem(item.id);
  if (!fresh || fresh.status !== "review") return;
  if (pr.state === "MERGED") {
    await emit({ itemId: item.id, type: "git", message: `pull request merged on GitHub${pr.mergedAt ? ` at ${pr.mergedAt}` : ""}` });
    await afterMerge(fresh, p);
    return;
  }
  if (pr.state === "CLOSED") {
    const it = await setStatus(item.id, "cancelled", { message: "the pull request was closed without merging" });
    await postStatus(it, { text: `#${it.id}: the pull request was closed on GitHub without merging, so the job is cancelled.`, level: "warning", important: true });
    return;
  }
  // Checks: a failure is feedback the agent can act on (it re-runs the tests locally).
  const failed = (pr.statusCheckRollup ?? []).filter((c) => (c.conclusion ?? c.state ?? "").toUpperCase() === "FAILURE" || (c.conclusion ?? "").toUpperCase() === "TIMED_OUT");
  const failKey = failed.map((c) => `${c.name ?? c.context}:${c.detailsUrl ?? c.targetUrl ?? ""}`).sort().join("|");
  if (failed.length && failKey) {
    await onComment(item.id, { source: "github", author: "CI", externalId: `checks:${item.head_sha ?? ""}:${failKey}`.slice(0, 500), kind: "changes_requested",
      body: `CI checks failed on the pull request:\n${failed.map((c) => `- ${c.name ?? c.context}${c.detailsUrl || c.targetUrl ? ` (${c.detailsUrl ?? c.targetUrl})` : ""}`).join("\n")}\nRun the project's tests and build locally, fix the cause, and commit.` });
  }
  let approved: { login: string; id: string } | null = null;
  for (const r of pr.reviews ?? []) {
    if (!r.author?.login || r.author.login === me || r.author.login.endsWith("[bot]") && !r.body) continue;
    if (!trusted(r.authorAssociation)) continue;
    // An approval counts for the commit it was given on: a fix pushed afterwards needs a fresh look.
    if (r.state === "APPROVED") { if (!r.commit?.oid || !item.head_sha || r.commit.oid === item.head_sha) approved = { login: r.author.login, id: r.id }; continue; }
    if (r.state === "CHANGES_REQUESTED" || (r.state === "COMMENTED" && r.body?.trim())) {
      await onComment(item.id, { source: "github", author: r.author.login, externalId: `review:${r.id}`, kind: r.state === "CHANGES_REQUESTED" ? "changes_requested" : "comment", body: r.body?.trim() || "changes requested" });
    }
  }
  for (const c of pr.comments ?? []) {
    if (!c.author?.login || c.author.login === me || !c.body?.trim() || !trusted(c.authorAssociation)) continue;
    await onComment(item.id, { source: "github", author: c.author.login, externalId: `comment:${c.id}`, body: c.body.trim() });
  }
  const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1];
  if (repo) {
    for (const c of await inlineComments(item.worktree!, repo, item.pr_number!)) {
      if (!c.user?.login || c.user.login === me || !c.body?.trim() || !trusted(c.author_association)) continue;
      await onComment(item.id, { source: "github", author: c.user.login, externalId: `inline:${c.id}`, body: `${c.path}${c.line ? `:${c.line}` : ""}: ${c.body.trim()}` });
    }
  }
  const after = await getItem(item.id);
  const laterChanges = approved ? (pr.reviews ?? []).some((r) => r.state === "CHANGES_REQUESTED" && trusted(r.authorAssociation) && r.author?.login !== me && r.submittedAt > ((pr.reviews ?? []).find((x) => x.id === approved!.id)?.submittedAt ?? "")) : false;
  if (approved && after?.status === "review" && (pr.reviewDecision === "APPROVED" || (!pr.reviewDecision && !laterChanges)) && !failed.length) {
    const already = await q("select 1 from feedback where item_id = $1 and source = 'github' and external_id = $2", [item.id, `review:${approved.id}`]);
    if (!already.length) await reviewDecision(item.id, "approved", "approved on GitHub", { via: "github", name: approved.login, externalId: `review:${approved.id}` });
  }
}

export function startPrWatch(): void {
  setInterval(() => watchPullRequests().catch((e) => console.error("pr watch", e)), 60 * 1000).unref();
  setTimeout(() => watchPullRequests().catch(() => {}), 20 * 1000).unref();
}
