import { useState, type ReactNode } from "react";
import { useApi } from "../lib/api";
import { fmtHours, money, num, pct } from "../lib/format";
import { familyOf, statusLabel, ORIGIN_LABEL } from "../lib/status";
import type { Metrics, Spend, StatusData } from "../lib/types";
import { ErrorNote, Loading, Page, Section, Segmented } from "../components/ui";
import { BarList, ChartFrame, ColumnChart, Legend, LineChart, Meter } from "../components/charts";

type Period = "7" | "30" | "90";

function Tile({ label, value, sub, children, className }: { label: string; value: string; sub?: string; children?: ReactNode; className?: string }) {
  return <div className={`tile ${className ?? ""}`}><div className="tile-label">{label}</div><div className="tile-value">{value}</div>{children}{sub && <div className="tile-sub">{sub}</div>}</div>;
}

/** Since midnight, whatever the period: the number the daily budget is held against. */
function SpendTile({ spend }: { spend: Spend | undefined }) {
  const budget = spend?.dailyBudgetUsd ?? 0;
  const share = spend && budget > 0 ? spend.today.total / budget : null;
  const sub = !spend ? "API-equivalent, since midnight" : share == null ? "since midnight; no daily budget" : share >= 1 ? `the ${money(budget)} daily budget is reached` : `${pct(share)} of the ${money(budget)} daily budget`;
  return (
    <Tile label="Spend today" value={money(spend?.today.total)} sub={sub} className="span2">
      {share != null && <div className="tile-meter"><Meter value={share} warnAt={0.8} badAt={1} label="Spend today against the daily budget" /></div>}
    </Tile>
  );
}

export default function MetricsPage() {
  const [period, setPeriod] = useState<Period>("30");
  const { data: m, error, reload } = useApi<Metrics>(`/api/metrics?days=${period}`);
  return (
    <Page title="Metrics" subtitle="How much is moving, how fast it lands, how often it lands the first time, and what it costs."
      aside={<Segmented label="Period" value={period} onChange={setPeriod} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />}>
      {error && <ErrorNote error={error} onRetry={reload} />}
      {!m && !error && <Loading />}
      {m && <Body m={m} />}
    </Page>
  );
}

function Body({ m }: { m: Metrics }) {
  const t = m.totals ?? { created: 0, done: 0, failed: 0, cancelled: 0, cost: 0, turns: 0 };
  const w = m.waiting ?? { approvals: 0, review: 0, needs_info: 0, blocked: 0, oldest_wait_h: null };
  const days = m.byDay.map((d) => d.day);
  const totalWaiting = w.approvals + w.review + w.needs_info + w.blocked;
  const { data: status } = useApi<StatusData>("/api/status");
  return (
    <>
      <Section first title="Flow" hint={`last ${m.days} days`}>
        <div className="tiles flow">
          <Tile label="Arrived" value={num(t.created)} sub="new requests" />
          <Tile label="Shipped" value={num(t.done)} sub={t.created ? `${pct(t.done / Math.max(1, t.created))} of arrivals` : undefined} />
          <Tile label="Failed" value={num(t.failed)} sub={t.cancelled ? `${num(t.cancelled)} cancelled` : "none cancelled"} />
          <Tile label="Lead time" value={fmtHours(m.lead?.median_h)} sub={m.lead?.p90_h != null ? `median; p90 ${fmtHours(m.lead.p90_h)}` : "median, arrival to done"} />
          <Tile label="First pass" value={pct(m.rounds?.first_pass)} sub={m.rounds?.fix != null ? `shipped with no fix round; ${m.rounds.fix.toFixed(1)} rounds on average` : "shipped with no fix round"} />
          <Tile label="Cost" value={money(t.cost)} sub={m.rounds?.cost_per_done != null ? `${money(m.rounds.cost_per_done)} per shipped change` : "API-equivalent"} />
          <SpendTile spend={status?.spend} />
        </div>
      </Section>

      <Section title="Waiting on people" hint={totalWaiting ? `oldest has waited ${fmtHours(w.oldest_wait_h)}` : "nobody is holding anything up"}>
        <div className="tiles four">
          <Tile label="Approvals" value={num(w.approvals)} />
          <Tile label="Reviews" value={num(w.review)} />
          <Tile label="Questions" value={num(w.needs_info)} />
          <Tile label="Blocked" value={num(w.blocked)} />
        </div>
      </Section>

      <Section title="Per day">
        <ChartFrame title="Arrived and shipped" hint="Requests per day"
          legend={<Legend items={[{ label: "Arrived", cls: "s1" }, { label: "Shipped", cls: "s2" }]} />}
          table={<table className="table"><thead><tr><th>Day</th><th className="r">Arrived</th><th className="r">Shipped</th><th className="r">Failed or cancelled</th><th className="r">Cost</th></tr></thead>
            <tbody>{[...m.byDay].reverse().map((d) => <tr key={d.day}><td>{d.day}</td><td className="r num">{d.created}</td><td className="r num">{d.done}</td><td className="r num">{d.failed}</td><td className="r num">{money(d.cost)}</td></tr>)}</tbody></table>}>
          <LineChart label={`Requests arrived and shipped per day over ${m.days} days`} days={days}
            series={[{ key: "created", label: "Arrived", cls: "s1", values: m.byDay.map((d) => d.created) }, { key: "done", label: "Shipped", cls: "s2", values: m.byDay.map((d) => d.done) }]} />
        </ChartFrame>
        <ChartFrame title="Agent cost" hint="API-equivalent dollars of runs finished each day"
          table={<table className="table"><thead><tr><th>Day</th><th className="r">Cost</th></tr></thead><tbody>{[...m.byDay].reverse().map((d) => <tr key={d.day}><td>{d.day}</td><td className="r num">{money(d.cost)}</td></tr>)}</tbody></table>}>
          <ColumnChart label={`Agent cost per day over ${m.days} days`} name="Cost" days={days} values={m.byDay.map((d) => d.cost)} cls="s1" fmt={(n) => (n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(n < 1 && n > 0 ? 2 : 0)}`)} />
        </ChartFrame>
      </Section>

      <Section title="Where the time goes" hint="Hours spent in each status, all requests together">
        {m.stages.length ? (
          <ChartFrame title="Hours by status"
            table={<table className="table"><thead><tr><th>Status</th><th className="r">Hours</th></tr></thead><tbody>{m.stages.map((s) => <tr key={s.status}><td>{statusLabel(s.status)}</td><td className="r num">{s.hours.toFixed(1)}</td></tr>)}</tbody></table>}>
            <BarList label="Hours spent in each status" fmt={fmtHours} rows={m.stages.filter((s) => !["done", "cancelled", "failed"].includes(s.status)).map((s) => ({ key: s.status, label: statusLabel(s.status), value: s.hours, cls: `f-${familyOf(s.status)}` }))} />
          </ChartFrame>
        ) : <p className="quiet">Nothing has moved in this period.</p>}
      </Section>

      <Section title="Projects">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Project</th><th className="r">Open</th><th className="r">Shipped</th><th className="r">Failed</th><th className="r">Median lead</th><th className="r">Cost</th></tr></thead>
            <tbody>{m.byProject.map((p) => <tr key={p.project_id}><td>{p.name}</td><td className="r num">{p.open}</td><td className="r num">{p.done}</td><td className="r num">{p.failed}</td><td className="r num">{fmtHours(p.median_h)}</td><td className="r num">{money(p.cost)}</td></tr>)}</tbody>
          </table>
        </div>
      </Section>

      <div className="two-col">
        <Section title="Where requests come from">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Source</th><th className="r">Arrived</th><th className="r">Shipped</th></tr></thead>
              <tbody>{m.bySource.length ? m.bySource.map((s) => <tr key={s.kind}><td>{ORIGIN_LABEL[s.kind] ?? s.kind}</td><td className="r num">{s.n}</td><td className="r num">{s.done}</td></tr>) : <tr><td colSpan={3} className="quiet">No requests in this period.</td></tr>}</tbody>
            </table>
          </div>
        </Section>
        <Section title="Runs">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Kind</th><th className="r">Runs</th><th className="r">Succeeded</th><th className="r">Avg time</th><th className="r">Avg turns</th><th className="r">Cost</th></tr></thead>
              <tbody>{m.runs.length ? m.runs.map((r) => <tr key={r.kind}><td>{r.kind}</td><td className="r num">{r.n}</td><td className="r num">{pct(r.ok / Math.max(1, r.n))}</td><td className="r num">{r.avg_min != null ? `${r.avg_min.toFixed(1)} min` : "—"}</td><td className="r num">{r.turns != null ? r.turns.toFixed(0) : "—"}</td><td className="r num">{money(r.cost)}</td></tr>) : <tr><td colSpan={6} className="quiet">No runs in this period.</td></tr>}</tbody>
            </table>
          </div>
        </Section>
      </div>
    </>
  );
}
