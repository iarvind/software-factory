import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { patch, post, useApi } from "../lib/api";
import { fmtDate, money, plural } from "../lib/format";
import { useMe } from "../lib/session";
import { CLOSED, ORIGIN_LABEL, STATUS, isActive, requestEditable, retryLabel, stoppedAt } from "../lib/status";
import type { ItemDetail } from "../lib/types";
import { Ago, Banner, Button, ErrorNote, Facts, Linkify, Loading, Menu, RefreshError, Section, Tabs, attempt, tabId } from "../components/ui";
import { OriginIcon, PriorityMark, StatusPill } from "../components/status";
import { Timeline } from "../components/Timeline";
import { DiffView } from "../components/Diff";
import { AnswerBox, Composer, DecisionBox, EditItemSheet, Messages, PlanCard, ReviewBox, RunsList, planOf, refreshItem } from "../components/ItemParts";

type Tab = "timeline" | "diff" | "runs" | "messages";
const TABS: Tab[] = ["timeline", "diff", "runs", "messages"];

export default function ItemPage() {
  const { id } = useParams();
  const itemId = Number(id);
  const { data, error, reload } = useApi<ItemDetail>(Number.isInteger(itemId) && itemId > 0 ? `/api/items/${itemId}` : null);
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.includes(params.get("tab") as Tab) ? (params.get("tab") as Tab) : "timeline";
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); if (t === "timeline") p.delete("tab"); else p.set("tab", t); setParams(p, { replace: true }); };
  const loc = useLocation();
  useEffect(() => { if (data?.item.title) document.title = `#${data.item.id} ${data.item.title} — Factory`; return () => { document.title = "Factory"; }; }, [data?.item.id, data?.item.title]);
  useEffect(() => { if (loc.hash && data) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: "center" }); }, [loc.hash, Boolean(data)]);

  if (error && !data) return <div className="page"><ErrorNote error={error} onRetry={reload} /><p><Link to="/" className="btn secondary">Back to the board</Link></p></div>;
  if (!data) return <div className="page"><Loading /></div>;
  const { item, project, runs } = data;
  const live = data.active || isActive(item.status);
  const plan = planOf(item.plan);

  return (
    <div className="page item-page">
      <header className="item-head">
        <div className="item-kicker">
          <Link to="/" className="quiet">Board</Link>
          <span className="quiet" aria-hidden="true">/</span>
          <span className="num quiet">#{item.id}</span>
          <StatusPill status={item.status} gate={item.gate} live={live} />
          <PriorityMark p={item.priority} />
          {stoppedAt(item) && <span className="tag bad">{stoppedAt(item)}</span>}
          {item.paused && <span className="tag">paused</span>}
          {item.labels.map((l) => <span key={l} className="chip">{l}</span>)}
        </div>
        <h1 className="page-title">{item.title}</h1>
        <p className="item-hint quiet">{sentence(STATUS[item.status]?.hint ?? "")}{item.status === "awaiting_approval" && item.gate ? ` (${item.gate})` : ""}.</p>
      </header>
      <RefreshError error={error} onRetry={reload} />

      <ItemFacts detail={data} />

      {item.error && (item.status === "blocked" || item.status === "failed") && <Banner tone="bad"><strong>{STATUS[item.status]?.label ?? item.status}:</strong> {item.error}</Banner>}
      {item.paused && !CLOSED.includes(item.status) && <Banner tone="wait">Paused: nothing new starts for this request until it is resumed.</Banner>}

      <Actions detail={data} onComment={() => { setTab("timeline"); setTimeout(() => document.getElementById("comment-box")?.focus(), 60); }} />

      {plan && <Section title="Plan"><PlanCard plan={plan} needsInfo={item.status === "needs_info"} /></Section>}

      <Section title="Request" hint={<>from {item.requester_name ?? "someone"} <Ago iso={item.created_at} /></>}>
        <RequestBody body={item.body} />
      </Section>

      <div className="section">
        <Tabs label="Item views" panelId="item-panel" value={tab} onChange={setTab} options={[
          { value: "timeline", label: "Timeline" },
          { value: "diff", label: "Changes" },
          { value: "runs", label: "Runs", count: runs.length },
          { value: "messages", label: "Messages", count: data.feedback.length + data.posts.length },
        ]} />
        <div className="tab-panel" role="tabpanel" id="item-panel" aria-labelledby={tabId("item-panel", tab)}>
          {tab === "timeline" && <Timeline itemId={item.id} runs={runs} live={live} composer={<MaybeComposer detail={data} />} />}
          {tab === "diff" && <DiffView itemId={item.id} hasWorktree={Boolean(item.worktree)} />}
          {tab === "runs" && <RunsList runs={runs} />}
          {tab === "messages" && <Messages detail={data} />}
        </div>
      </div>
      {!project && item.project_id == null && <p className="quiet">This request has no project yet, so it cannot be planned. Edit it to pick one.</p>}
    </div>
  );
}

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function MaybeComposer({ detail }: { detail: ItemDetail }) {
  const me = useMe();
  if (!me.canEdit) return null;
  return <Composer item={detail.item} id="comment-box" />;
}

function ItemFacts({ detail }: { detail: ItemDetail }) {
  const { item, project } = detail;
  const originKind = item.origin?.kind ?? "manual";
  return (
    <Facts items={[
      ["Project", project ? <Link to={`/projects/${project.id}`}>{project.name}</Link> : <span className="quiet">none</span>],
      ["Requested by", <span className="inline-tight"><OriginIcon origin={item.origin} />{item.requester_name ?? "unknown"}<span className="quiet">via {ORIGIN_LABEL[originKind] ?? originKind}</span>{item.external_url && <a href={item.external_url} target="_blank" rel="noreferrer noopener">source</a>}</span>],
      ["Branch", item.branch ? <span className="mono">{item.branch}</span> : <span className="quiet">not yet</span>],
      ["Delivery", item.pr_url ? <a href={item.pr_url} target="_blank" rel="noreferrer noopener">Pull request {item.pr_number ? `#${item.pr_number}` : ""}</a> : project?.delivery === "local" ? "Local merge" : <span className="quiet">pull request, when built</span>],
      ["Arrived", <span title={fmtDate(item.created_at)}><Ago iso={item.created_at} /></span>],
      ["Updated", <Ago iso={item.updated_at} />],
      ["Cost", <span className="num" title="API-equivalent cost reported by the runner">{money(item.cost_usd)}</span>],
      ["Turns", <span className="num">{item.turns}</span>],
      ["Rounds", <span className="num">{plural(item.fix_rounds, "fix", "fixes")}, {plural(item.verify_rounds, "verify", "verifies")}</span>],
      item.finished_at ? ["Finished", <Ago iso={item.finished_at} />] : null,
    ]} />
  );
}

function RequestBody({ body }: { body: string }) {
  const [all, setAll] = useState(false);
  if (!body.trim()) return <p className="quiet">No details beyond the title.</p>;
  const long = body.length > 1400 || body.split("\n").length > 24;
  return (
    <div className="request">
      <Linkify text={long && !all ? `${body.slice(0, 1400).split("\n").slice(0, 24).join("\n")}…` : body} />
      {long && <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? "Show less" : "Show all"}</Button>}
    </div>
  );
}

function Actions({ detail, onComment }: { detail: ItemDetail; onComment: () => void }) {
  const me = useMe();
  const [editing, setEditing] = useState(false);
  const { item, pending, project } = detail;
  if (!me.canEdit) return <p className="quiet viewer-note">You can watch this request; a member can act on it.</p>;
  const closed = CLOSED.includes(item.status);
  const canRetry = ["blocked", "failed", "cancelled", "needs_info"].includes(item.status);
  const act = (path: string, ok: string, body?: unknown) => attempt(async () => { await post(`/api/items/${item.id}/${path}`, body ?? {}); refreshItem(item.id); }, ok);
  const nudge = (action: string, ok: string) => act("nudge", ok, { action });
  const nudges = [
    pending ? { label: `Approve the ${pending.kind} gate`, hint: "Same as pressing Approve", onSelect: () => nudge("approve_gate", "Gate opened") } : null,
    item.status === "review" ? { label: "Skip review and approve", hint: "Moves straight to the merge gate", onSelect: () => nudge("skip_review", "Approved without review") } : null,
    !closed ? { label: "Mark done", hint: "Close it as shipped, without merging", onSelect: () => { if (confirm(`Mark #${item.id} done? Nothing more will be built or merged.`)) void nudge("mark_done", "Marked done"); } } : null,
  ].filter((x): x is NonNullable<typeof x> => Boolean(x));
  return (
    <>
      {item.status === "awaiting_approval" && pending && (me.canApprove
        ? <DecisionBox item={item} pending={pending} branch={project?.default_branch ?? "the default branch"} />
        : <Banner tone="wait">Waiting for an admin to approve the {pending.kind}. Only admins open gates here.</Banner>)}
      {item.status === "review" && (me.canApprove
        ? <ReviewBox item={item} delivery={project?.delivery} />
        : <Banner tone="wait">Waiting for an admin to review the change. You can still comment below.</Banner>)}
      {item.status === "needs_info" && <AnswerBox item={item} />}
      <div className="actionbar">
        <Button variant="secondary" size="sm" onClick={onComment}>Comment</Button>
        {requestEditable(item)
          ? <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Edit</Button>
          : <Button variant="secondary" size="sm" disabled title="The request is frozen once the plan is accepted; comment instead.">Edit</Button>}
        {!closed && <Button variant="secondary" size="sm" onClick={() => attempt(async () => { await patch(`/api/items/${item.id}`, { paused: !item.paused }); refreshItem(item.id); }, item.paused ? "Resumed" : "Paused")}>{item.paused ? "Resume" : "Pause"}</Button>}
        {canRetry && <Button variant="secondary" size="sm" title={retryLabel(item)} onClick={() => act("retry", "Going again")}>Retry</Button>}
        {me.canApprove && nudges.length > 0 && <Menu size="sm" label="Nudge" items={nudges} />}
        <span className="grow" />
        {!closed && <Button variant="danger" size="sm" onClick={() => { if (confirm(`Cancel #${item.id}? A run in progress stops now.`)) void act("cancel", "Cancelled"); }}>Cancel request</Button>}
      </div>
      {editing && <EditItemSheet item={item} open onClose={() => setEditing(false)} />}
    </>
  );
}
