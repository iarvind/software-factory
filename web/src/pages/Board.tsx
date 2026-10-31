import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { invalidate, invalidateKey, post, useApi } from "../lib/api";
import { useNow } from "../lib/clock";
import { age, money, short } from "../lib/format";
import { useMe } from "../lib/session";
import { COLUMNS, GATE_LABEL, STATUS, familyOf, isActive, retryLabel, statusLabel, stoppedAt, type Column } from "../lib/status";
import type { BoardData, BoardProject, Item, PendingApproval } from "../lib/types";
import { Button, ErrorNote, Field, Input, Loading, Page, RefreshError, Select, Sheet, Spinner, Textarea, attempt } from "../components/ui";
import { Lamp, OriginIcon, PriorityMark } from "../components/status";
import { Icon } from "../components/icons";
import { NewRequestSheet } from "../components/NewRequest";
import { planOf } from "../components/ItemParts";

export default function Board() {
  const me = useMe();
  const { data, error, reload } = useApi<BoardData>("/api/board");
  const { data: approvals, error: approvalsError, reload: reloadApprovals } = useApi<PendingApproval[]>("/api/approvals");
  const [params, setParams] = useSearchParams();
  const project = params.get("project") ?? "";
  const q = params.get("q") ?? "";
  const [creating, setCreating] = useState(false);
  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };

  const projects = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.id, p])), [data]);
  const activeIds = useMemo(() => new Set((data?.active ?? []).map((a) => a.itemId)), [data]);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.items ?? []).filter((i) =>
      (!project || String(i.project_id ?? "") === project) &&
      (!needle || i.title.toLowerCase().includes(needle) || String(i.id) === needle.replace(/^#/, "") || i.labels.some((l) => l.toLowerCase().includes(needle)) || (i.requester_name ?? "").toLowerCase().includes(needle)));
  }, [data, project, q]);
  const pending = (approvals ?? []).filter((a) => !project || String(a.project_id ?? "") === project);

  if (error && !data) return <Page title="Board" wide><ErrorNote error={error} onRetry={reload} /></Page>;
  if (!data) return <Page title="Board" wide><Loading /></Page>;

  const open = items.filter((i) => !["done", "cancelled", "failed"].includes(i.status)).length;
  const working = items.filter((i) => activeIds.has(i.id) || isActive(i.status)).length;
  const waiting = items.filter((i) => familyOf(i.status) === "wait" || i.status === "review").length;

  return (
    <Page wide title="Board"
      subtitle={<>{open} open, {working} being worked on, {waiting} waiting on a person.</>}
      aside={<>
        <Select aria-label="Filter by project" value={project} onChange={(e) => setParam("project", e.target.value)} className="sm">
          <option value="">All projects</option>
          {data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Input type="search" aria-label="Filter cards" placeholder="Filter" value={q} onChange={(e) => setParam("q", e.target.value)} className="sm search" />
        {me.canEdit && <Button onClick={() => setCreating(true)}><Icon name="plus" />New request</Button>}
      </>}>
      <RefreshError error={error ?? approvalsError} onRetry={() => { reload(); reloadApprovals(); }} />
      <NeedsYou items={items} approvals={pending} canAct={me.canEdit} canApprove={me.canApprove} />
      <div className="board" role="list" aria-label="Board columns">
        {COLUMNS.map((col) => <BoardColumn key={col.key} col={col} items={items} projects={projects} activeIds={activeIds} />)}
      </div>
      <NewRequestSheet open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

function BoardColumn({ col, items, projects, activeIds }: { col: Column; items: Item[]; projects: Map<number, BoardProject>; activeIds: Set<number> }) {
  let list = items.filter((i) => col.statuses.includes(i.status));
  if (col.key === "done") list = [...list].sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? "")).slice(0, 30);
  return (
    <section className={`col f-${col.family} ${list.length ? "" : "empty"}`} role="listitem" aria-label={`${col.label}: ${list.length}`}>
      <header className="col-head" title={col.hint}>
        <span className="lamp" aria-hidden="true" />
        <h2>{col.label}</h2>
        <span className="col-count num">{list.length}</span>
      </header>
      <div className="col-body">
        {list.length ? list.map((i) => <Card key={i.id} item={i} project={i.project_id ? projects.get(i.project_id) : undefined} live={activeIds.has(i.id)} />) : <div className="col-empty">{col.hint}</div>}
      </div>
    </section>
  );
}

function Card({ item, project, live }: { item: Item; project?: BoardProject; live: boolean }) {
  const now = useNow();
  const st = STATUS[item.status];
  const running = live || isActive(item.status);
  return (
    <article className="card">
      <div className="card-top">
        <span className="card-id num">#{item.id}</span>
        <PriorityMark p={item.priority} />
        <OriginIcon origin={item.origin} />
        {item.paused && <span className="tag"><Icon name="pause" size={12} />paused</span>}
        <span className="grow" />
        {running && <Spinner label="An agent is working on this" />}
        <span className="card-age num" title={`Arrived ${new Date(item.created_at).toLocaleString()}`}>{age(item.created_at, now)}</span>
      </div>
      <h3 className="card-title"><Link to={`/items/${item.id}`} className="stretch">{item.title}</Link></h3>
      <div className="card-meta">
        <CardStage item={item} />
        {stoppedAt(item) && <span>{stoppedAt(item)}</span>}
        {project && <span className="card-project">{project.name}</span>}
        {item.cost_usd > 0 && <span className="num">{money(item.cost_usd)}</span>}
      </div>
      {st.family === "bad" && item.error && <p className="card-error">{short(item.error, 120)}</p>}
    </article>
  );
}

function CardStage({ item }: { item: Item }) {
  const f = familyOf(item.status);
  if (item.status === "awaiting_approval") return <span className="stage"><Lamp family={f} />{GATE_LABEL[item.gate ?? ""] ?? "Gate"} approval</span>;
  if (item.status === "review") {
    if (item.pr_url) return <span className="stage"><Lamp family={f} /><a className="above" href={item.pr_url} target="_blank" rel="noreferrer noopener">PR {item.pr_number ? `#${item.pr_number}` : ""}</a></span>;
    return <span className="stage"><Lamp family={f} />Local branch</span>;
  }
  return <span className="stage"><Lamp family={f} />{statusLabel(item.status)}</span>;
}

// ---------- what a person must do next ----------

function NeedsYou({ items, approvals, canAct, canApprove }: { items: Item[]; approvals: PendingApproval[]; canAct: boolean; canApprove: boolean }) {
  const [rejecting, setRejecting] = useState<PendingApproval | null>(null);
  const [all, setAll] = useState(false);
  const answers = items.filter((i) => i.status === "needs_info");
  const stuck = items.filter((i) => i.status === "blocked" || i.status === "failed").filter((i) => i.status === "blocked" || (i.finished_at && Date.now() - new Date(i.finished_at).getTime() < 86400000));
  const total = approvals.length + answers.length + stuck.length;
  if (!total) return null;
  const rows: React.ReactNode[] = [
    ...approvals.map((a) => <ApprovalRow key={`a${a.id}`} a={a} canAct={canApprove} onReject={() => setRejecting(a)} />),
    ...answers.map((i) => (
      <NeedRow key={`n${i.id}`} item={i} what="Waiting for an answer" detail={planOf(i.plan)?.questions[0] ?? "The planner has a question before it can go on."}
        actions={<Link className="btn sm secondary" to={`/items/${i.id}#answer`}>Answer</Link>} />
    )),
    ...stuck.map((i) => (
      <NeedRow key={`s${i.id}`} item={i} what={[statusLabel(i.status), stoppedAt(i)].filter(Boolean).join(", ")} detail={i.error ?? "Stopped."}
        actions={canAct ? <Button size="sm" variant="secondary" title={retryLabel(i)} onClick={() => attempt(async () => { await post(`/api/items/${i.id}/retry`); invalidate("/api/board"); invalidateKey(`/api/items/${i.id}`); }, `#${i.id} is going again`)}>Retry</Button> : null} />
    )),
  ];
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <section className="needs" aria-labelledby="needs-title">
      <div className="needs-head">
        <h2 id="needs-title">Needs you</h2>
        <span className="num quiet">{total}</span>
      </div>
      <div className="needs-list">{shown}</div>
      {rows.length > 5 && <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show ${rows.length - 5} more`}</Button>}
      <RejectSheet approval={rejecting} onClose={() => setRejecting(null)} />
    </section>
  );
}

function NeedRow({ item, what, detail, actions }: { item: Item; what: string; detail: string; actions?: React.ReactNode }) {
  return (
    <div className="need">
      <Lamp family={familyOf(item.status)} />
      <div className="grow">
        <div className="need-title"><Link to={`/items/${item.id}`}><span className="num quiet">#{item.id}</span> {item.title}</Link></div>
        <div className="need-sub"><strong>{what}.</strong> {short(detail, 180)}</div>
      </div>
      {actions && <div className="need-actions">{actions}</div>}
    </div>
  );
}

function ApprovalRow({ a, canAct, onReject }: { a: PendingApproval; canAct: boolean; onReject: () => void }) {
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    await attempt(async () => { await post(`/api/items/${a.item_id}/approve`, {}); invalidate("/api/board", "/api/approvals"); invalidateKey(`/api/items/${a.item_id}`); }, `${GATE_LABEL[a.kind] ?? a.kind} approved for #${a.item_id}`);
    setBusy(false);
  };
  return (
    <div className="need">
      <Lamp family="wait" />
      <div className="grow">
        <div className="need-title"><Link to={`/items/${a.item_id}`}><span className="num quiet">#{a.item_id}</span> {a.title}</Link></div>
        <div className="need-sub"><strong>{GATE_LABEL[a.kind] ?? a.kind} approval.</strong> {short(a.summary ?? "", 200)}</div>
      </div>
      {canAct && (
        <div className="need-actions">
          <Button size="sm" variant="secondary" onClick={onReject} disabled={busy}>Reject</Button>
          <Button size="sm" onClick={approve} disabled={busy}>Approve</Button>
        </div>
      )}
    </div>
  );
}

export function RejectSheet({ approval, onClose }: { approval: { item_id: number; kind: string } | null; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (!approval) return null;
  const consequence = approval.kind === "plan" ? "Rejecting a plan cancels the request." : `Rejecting the ${approval.kind} parks the request as blocked until someone retries or cancels it.`;
  const submit = async () => {
    setBusy(true);
    const ok = await attempt(async () => {
      await post(`/api/items/${approval.item_id}/reject`, note.trim() ? { note: note.trim() } : {});
      invalidate("/api/board", "/api/approvals"); invalidateKey(`/api/items/${approval.item_id}`);
    }, `${GATE_LABEL[approval.kind] ?? approval.kind} rejected for #${approval.item_id}`);
    setBusy(false);
    if (ok) { setNote(""); onClose(); }
  };
  return (
    <Sheet open onClose={onClose} title={`Reject the ${approval.kind} for #${approval.item_id}`}
      footer={<><Button variant="secondary" onClick={onClose}>Keep waiting</Button><Button variant="danger" onClick={submit} disabled={busy}>Reject</Button></>}>
      <p className="quiet">{consequence}</p>
      <Field label="Why (optional)" hint="Shown on the timeline and sent to where the request came from.">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
      </Field>
    </Sheet>
  );
}

