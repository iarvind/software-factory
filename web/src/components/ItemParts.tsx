// The pieces of the item page: the plan, the decision boxes, runs, messages, and the edit sheet.
import { useState, type ReactNode } from "react";
import { invalidate, invalidateKey, patch, post, useApi } from "../lib/api";
import { fmtDate, fmtMs, money, splitList } from "../lib/format";
import { GATE_LABEL, PRIORITY } from "../lib/status";
import type { Approval, BoardData, Feedback, Item, ItemDetail, Plan, Post, Run } from "../lib/types";
import { Ago, Button, CopyButton, Empty, Field, Input, Linkify, Loading, Select, Sheet, Textarea, attempt } from "./ui";
import { Lamp } from "./status";

export const refreshItem = (id: number) => { invalidateKey(`/api/items/${id}`); invalidate("/api/board", "/api/approvals", "/api/items?"); };

// ---------- plan ----------

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
/** A plan as stored can be old or partial (a runner that skipped a field, an earlier schema): fill what is missing. */
export function planOf(p: Partial<Plan> | null | undefined): Plan | null {
  if (!p || typeof p !== "object") return null;
  const risk = p.risk === "low" || p.risk === "medium" || p.risk === "high" ? p.risk : "medium";
  return {
    summary: typeof p.summary === "string" ? p.summary : "", kind: typeof p.kind === "string" && p.kind ? p.kind : "change",
    size: typeof p.size === "string" && p.size ? p.size : "?", risk, clarity: p.clarity === "needs_info" ? "needs_info" : "clear",
    questions: strings(p.questions), steps: strings(p.steps), files: strings(p.files), tests: strings(p.tests), risks: strings(p.risks), acceptance: strings(p.acceptance),
    estimate_minutes: typeof p.estimate_minutes === "number" && Number.isFinite(p.estimate_minutes) ? p.estimate_minutes : 0,
  };
}

function List({ title, items, ordered, mono }: { title: string; items: string[] | undefined; ordered?: boolean; mono?: boolean }) {
  if (!items?.length) return null;
  const L = ordered ? "ol" : "ul";
  return <div className="plan-list"><h3>{title}</h3><L className={mono ? "mono-list" : undefined}>{items.map((x, i) => <li key={i}>{x}</li>)}</L></div>;
}

export function PlanCard({ plan, needsInfo }: { plan: Plan; needsInfo: boolean }) {
  return (
    <div className="plan">
      <p className="plan-summary">{plan.summary}</p>
      <div className="plan-chips">
        <span className="chip">{plan.kind}</span>
        <span className="chip">size {plan.size.toUpperCase()}</span>
        <span className={`chip ${plan.risk === "high" ? "risk-high" : ""}`}>{plan.risk} risk</span>
        {plan.estimate_minutes ? <span className="chip num">about {fmtMs(plan.estimate_minutes * 60000)}</span> : null}
        {plan.clarity === "needs_info" && <span className="chip risk-wait">needs an answer</span>}
      </div>
      {plan.questions.length > 0 && (
        <div className={`plan-list questions ${needsInfo ? "f-wait" : ""}`}><h3>Questions for the requester</h3><ul>{plan.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>
      )}
      <div className="plan-grid">
        <List title="Steps" items={plan.steps} ordered />
        <List title="Acceptance" items={plan.acceptance} />
        <List title="Files" items={plan.files} mono />
        <List title="Tests" items={plan.tests} />
        <List title="Risks" items={plan.risks} />
      </div>
    </div>
  );
}

// ---------- the boxes that ask a person for something ----------

const GATE_CONSEQUENCE: Record<string, (branch: string) => string> = {
  plan: () => "Approving queues the build. Rejecting cancels the request.",
  merge: (b) => `Approving merges the change into ${b}. Rejecting parks it as blocked.`,
  deploy: () => "Approving runs the project's deploy command and health check. Rejecting parks it as blocked.",
};

export function DecisionBox({ item, pending, branch }: { item: Item; pending: Approval; branch: string }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (verb: "approve" | "reject") => {
    setBusy(true);
    await attempt(async () => { await post(`/api/items/${item.id}/${verb}`, note.trim() ? { note: note.trim() } : {}); setNote(""); refreshItem(item.id); }, verb === "approve" ? `${GATE_LABEL[pending.kind]} approved` : `${GATE_LABEL[pending.kind]} rejected`);
    setBusy(false);
  };
  return (
    <div className="ask f-wait">
      <div className="ask-head"><Lamp family="wait" /><h2>{GATE_LABEL[pending.kind] ?? pending.kind} approval</h2><span className="quiet">asked <Ago iso={pending.requested_at} /></span></div>
      {pending.summary && <Linkify className="ask-text" text={pending.summary} />}
      <p className="quiet">{GATE_CONSEQUENCE[pending.kind]?.(branch) ?? ""}</p>
      <Field label="Note (optional)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Anything the agent or the requester should know" /></Field>
      <div className="ask-actions">
        <Button variant="danger" onClick={() => decide("reject")} disabled={busy}>Reject</Button>
        <Button onClick={() => decide("approve")} disabled={busy}>Approve {pending.kind}</Button>
      </div>
    </div>
  );
}

export function ReviewBox({ item, delivery }: { item: Item; delivery: string | undefined }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (decision: "approved" | "changes_requested") => {
    setBusy(true);
    await attempt(async () => { await post(`/api/items/${item.id}/review`, { decision, ...(body.trim() ? { body: body.trim() } : {}) }); setBody(""); refreshItem(item.id); }, decision === "approved" ? "Approved" : "Changes requested: the agent will address them");
    setBusy(false);
  };
  return (
    <div className="ask f-review">
      <div className="ask-head"><Lamp family="review" /><h2>Review the change</h2></div>
      <p className="quiet">
        {item.pr_url ? <>The change is in <a href={item.pr_url} target="_blank" rel="noreferrer noopener">pull request {item.pr_number ? `#${item.pr_number}` : ""}</a>. Reviews left on the pull request count too.</>
          : delivery === "local" ? <>The change is on the local branch <span className="mono">{item.branch}</span>. Read it under Changes.</>
          : "Read the change under Changes."}
        {" "}Approving moves it to the merge gate; requesting changes starts a fix round.
      </p>
      <Field label="Comment" hint="Required when you request changes. Be specific: file, behaviour, what you expect instead.">
        <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} />
      </Field>
      <div className="ask-actions">
        <Button variant="secondary" onClick={() => send("changes_requested")} disabled={busy || !body.trim()}>Request changes</Button>
        <Button onClick={() => send("approved")} disabled={busy}>Approve</Button>
      </div>
    </div>
  );
}

export function AnswerBox({ item }: { item: Item }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const qs = planOf(item.plan)?.questions ?? [];
  const send = async () => {
    setBusy(true);
    await attempt(async () => { await post(`/api/items/${item.id}/comment`, { body: body.trim() }); setBody(""); refreshItem(item.id); }, "Answer sent: planning again");
    setBusy(false);
  };
  return (
    <div className="ask f-wait" id="answer">
      <div className="ask-head"><Lamp family="wait" /><h2>The planner needs an answer</h2></div>
      {qs.length ? <ol className="ask-questions">{qs.map((q, i) => <li key={i}>{q}</li>)}</ol> : <p className="quiet">The plan says it cannot go on without more information. Read the timeline for what it asked.</p>}
      <Field label="Your answer" hint="Sending it puts the request back in the inbox to be planned again.">
        <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} />
      </Field>
      <div className="ask-actions"><Button onClick={send} disabled={busy || !body.trim()}>Send answer</Button></div>
    </div>
  );
}

/** The always-there comment box at the end of the timeline. */
export function Composer({ item, id }: { item: Item; id?: string }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const hint = item.status === "review" ? "In review, a comment counts as a change request: the agent starts a fix round."
    : item.status === "needs_info" ? "This is the answer to the planner's questions; it plans again after you send it."
    : "Kept with the request; the next run reads it.";
  const send = async () => {
    setBusy(true);
    await attempt(async () => { await post(`/api/items/${item.id}/comment`, { body: body.trim() }); setBody(""); refreshItem(item.id); }, "Comment added");
    setBusy(false);
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); if (body.trim()) void send(); }}>
      <Field label="Comment" hint={hint}>
        <Textarea id={id} rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} placeholder="Add context, answer a question, or point at something" />
      </Field>
      <div className="ask-actions"><Button type="submit" disabled={busy || !body.trim()}>Comment</Button></div>
    </form>
  );
}

// ---------- runs ----------

const runFamily = (s: string) => (s === "running" ? "work" : s === "succeeded" ? "done" : s === "cancelled" ? "idle" : "bad");

export function RunsList({ runs }: { runs: Run[] }) {
  const [viewing, setViewing] = useState<number | null>(null);
  if (!runs.length) return <Empty title="No runs yet" hint="Each time an agent plans, builds, fixes or reviews, its run appears here with the exact prompt it was given." />;
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Run</th><th>Status</th><th>Model</th><th className="r">Turns</th><th className="r">Cost</th><th className="r">Took</th><th>Started</th><th><span className="sr-only">Prompt</span></th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.kind}</strong> <span className="quiet num">#{r.id}</span></td>
                <td><span className="inline"><Lamp family={runFamily(r.status)} />{r.status}</span>{r.error && <div className="error sm">{r.error}</div>}</td>
                <td><span className="mono">{r.model ?? r.runner}</span>{r.effort && <span className="quiet"> {r.effort}</span>}</td>
                <td className="r num">{r.turns ?? "—"}</td>
                <td className="r num">{money(r.cost_usd)}</td>
                <td className="r num">{r.started_at && r.finished_at ? fmtMs(new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) : r.status === "running" ? "running" : "—"}</td>
                <td><Ago iso={r.started_at ?? r.created_at} /></td>
                <td className="r"><Button size="sm" variant="secondary" onClick={() => setViewing(r.id)}>View prompt</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {viewing != null && <RunSheet id={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function Block({ title, text, copy }: { title: string; text: string; copy?: boolean }) {
  return (
    <div className="run-block">
      <div className="run-block-head"><h3>{title}</h3>{copy && <CopyButton text={text} />}</div>
      <pre className="code">{text}</pre>
    </div>
  );
}

function RunSheet({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: r, error } = useApi<Run>(`/api/runs/${id}`);
  return (
    <Sheet open onClose={onClose} title={r ? `${r.kind} run #${r.id}` : `Run #${id}`} wide>
      {error ? <p className="error">{error}</p> : !r ? <Loading /> : (
        <div className="stack">
          <p className="quiet">{r.runner}{r.model ? `, ${r.model}` : ""}{r.effort ? `, effort ${r.effort}` : ""}. {r.status}{r.exit_code != null ? ` (exit ${r.exit_code})` : ""}. {r.session_id && <>Session <span className="mono">{r.session_id}</span>.</>}</p>
          {r.error && <p className="error">{r.error}</p>}
          <Block title="Prompt" text={r.prompt ?? "(not recorded)"} copy />
          {r.result && <Block title="Final message" text={r.result} copy />}
          {r.structured != null && <Block title="Structured answer" text={JSON.stringify(r.structured, null, 2)} />}
          {r.usage != null && <Block title="Usage" text={JSON.stringify(r.usage, null, 2)} />}
        </div>
      )}
    </Sheet>
  );
}

// ---------- what was said, and to whom ----------

const FEEDBACK_LABEL: Record<Feedback["kind"], string> = { comment: "Comment", changes_requested: "Changes requested", approved: "Approved", answer: "Answer" };

export function Messages({ detail }: { detail: ItemDetail }) {
  const { feedback, posts, approvals } = detail;
  return (
    <div className="stack-lg">
      <MsgSection title="Said to the factory" hint="Comments, answers and review verdicts, from here and from where the request came from." empty="No comments yet.">
        {feedback.map((f) => (
          <div className="msg" key={f.id}>
            <div className="msg-head"><strong>{f.author ?? f.source}</strong><span className="tag">{FEEDBACK_LABEL[f.kind]}</span>{f.source !== "ui" && <span className="quiet">via {f.source}</span>}<span className="grow" />{f.handled_at ? <span className="quiet">addressed</span> : f.kind !== "approved" ? <span className="quiet">not yet addressed</span> : null}<Ago iso={f.created_at} className="quiet" /></div>
            <Linkify text={f.body} />
          </div>
        ))}
      </MsgSection>
      <MsgSection title="Told to people" hint="Status updates posted back to Slack, Jira, GitHub or Telegram." empty="Nothing has been posted anywhere yet.">
        {posts.map((p: Post) => (
          <div className={`msg ${p.ok ? "" : "failed"}`} key={p.id}>
            <div className="msg-head"><strong>{p.target}</strong>{!p.ok && <span className="tag bad">not delivered</span>}<span className="grow" /><Ago iso={p.created_at} className="quiet" /></div>
            {p.body && <Linkify text={p.body} />}
            {p.error && <p className="error">{p.error}</p>}
          </div>
        ))}
      </MsgSection>
      <MsgSection title="Gates" hint="Every approval asked for, and who decided." empty="No gate has been asked for yet.">
        {approvals.map((a) => (
          <div className="msg" key={a.id}>
            <div className="msg-head"><strong>{GATE_LABEL[a.kind] ?? a.kind}</strong><span className="tag">{a.status}</span>{a.decided_via && <span className="quiet">via {a.decided_via}</span>}<span className="grow" /><span className="quiet">{fmtDate(a.requested_at)}{a.decided_at ? `, decided ${fmtDate(a.decided_at)}` : ""}</span></div>
            {a.summary && <Linkify text={a.summary} />}
            {a.note && <p className="quiet">Note: {a.note}</p>}
          </div>
        ))}
      </MsgSection>
    </div>
  );
}
function MsgSection({ title, hint, empty, children }: { title: string; hint: string; empty: string; children: ReactNode[] }) {
  return (
    <section>
      <div className="section-head"><div className="inline"><h3 className="section-title">{title}</h3><span className="section-hint">{hint}</span></div></div>
      {children.length ? <div className="msgs">{children}</div> : <p className="quiet">{empty}</p>}
    </section>
  );
}

// ---------- edit ----------

export function EditItemSheet({ item, open, onClose }: { item: Item; open: boolean; onClose: () => void }) {
  const { data: board } = useApi<BoardData>("/api/board");
  const [d, setD] = useState({ title: item.title, body: item.body, projectId: item.project_id ? String(item.project_id) : "", priority: String(item.priority), labels: item.labels.join(", ") });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const ok = await attempt(async () => {
      const it = await patch<Item>(`/api/items/${item.id}`, { title: d.title.trim(), body: d.body, projectId: d.projectId ? Number(d.projectId) : null, priority: Number(d.priority), labels: splitList(d.labels).slice(0, 20) });
      refreshItem(it.id);
    }, "Saved");
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title={`Edit #${item.id}`} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={busy || d.title.trim().length < 2}>Save</Button></>}>
      <div className="form">
        <Field label="Title" required><Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} maxLength={300} /></Field>
        <Field label="Request"><Textarea rows={8} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} /></Field>
        <div className="grid3">
          <Field label="Project">
            <Select value={d.projectId} onChange={(e) => setD({ ...d, projectId: e.target.value })}>
              <option value="">Not decided</option>
              {(board?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value })}>
              {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{PRIORITY[p]} (P{p})</option>)}
            </Select>
          </Field>
          <Field label="Labels" hint="Comma separated"><Input value={d.labels} onChange={(e) => setD({ ...d, labels: e.target.value })} /></Field>
        </div>
        <p className="quiet">Changing the request does not restart work already under way; retry to plan again with the new text.</p>
      </div>
    </Sheet>
  );
}

