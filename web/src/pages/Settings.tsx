import { useEffect, useState } from "react";
import { del, invalidate, post, put, useApi } from "../lib/api";
import { fmtDate, money, pct } from "../lib/format";
import { useMe } from "../lib/session";
import { saveTheme, savedTheme, type Theme } from "../lib/theme";
import type { ApiToken, DeviceSession, Settings, SettingsData, Spend, Usage } from "../lib/types";
import { Ago, Button, Check, CopyButton, ErrorNote, Facts, Field, Group, Input, Loading, Page, Section, Segmented, Select, attempt, toast } from "../components/ui";
import { Meter } from "../components/charts";

export default function SettingsPage() {
  const me = useMe();
  const { data, error, reload } = useApi<SettingsData>("/api/settings");
  return (
    <Page title="Settings" subtitle={me.isAdmin ? "Factory-wide switches, what is installed, and your own devices and tokens." : "How the factory is set up, and your own devices and tokens. Admins change the factory-wide switches."}>
      {error && <ErrorNote error={error} onRetry={reload} />}
      {!data && !error && <Loading label="Checking the runners" />}
      {data && <KillSwitch s={data.settings} canChange={me.isAdmin} />}
      {data && <Switches s={data.settings} spend={data.spend} canChange={me.isAdmin} />}
      {data && <Machinery d={data} />}
      <Appearance />
      <Devices />
      <Tokens />
    </Page>
  );
}

function KillSwitch({ s, canChange }: { s: Settings; canChange: boolean }) {
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    if (!s.paused && !confirm("Pause the factory? Nothing new starts until it is resumed. Runs already going finish their current step.")) return;
    setBusy(true);
    await attempt(async () => { await put("/api/settings", { paused: !s.paused }); invalidate("/api/settings", "/api/board"); }, s.paused ? "The factory is running again" : "The factory is paused");
    setBusy(false);
  };
  return (
    <section className={`killswitch ${s.paused ? "f-wait paused" : "f-done"}`}>
      <span className="lamp big" aria-hidden="true" />
      <div className="grow">
        <h2>{s.paused ? "The factory is paused" : "The factory is running"}</h2>
        <p className="quiet">{s.paused
          ? "Nothing new starts: no planning, no builds, no merges. Runs that were already going finish their current step. Requests keep arriving and wait."
          : "The stop cord. Pausing holds every new run across every project at once; use it when something is going wrong and you need the floor to stand still."}</p>
      </div>
      {canChange && <Button variant={s.paused ? "primary" : "danger"} onClick={flip} disabled={busy}>{s.paused ? "Resume the factory" : "Pause the factory"}</Button>}
    </section>
  );
}

const formOf = (s: Settings) => ({
  maxConcurrentRuns: String(s.maxConcurrentRuns), approverRole: s.approverRole, keepWorktreeDays: String(s.keepWorktreeDays), newAccountRole: s.newAccountRole, usageThreshold: String(Math.round(s.usageThreshold * 100)),
  dailyBudgetUsd: String(s.dailyBudgetUsd ?? 0), digestHour: String(s.digestHour ?? -1),
});
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function Switches({ s, spend, canChange }: { s: Settings; spend: Spend | undefined; canChange: boolean }) {
  const [f, setF] = useState(() => formOf(s));
  // Reset the form when the saved values change, not on every refetch that brings back the same ones.
  const saved = JSON.stringify(formOf(s));
  useEffect(() => { setF(JSON.parse(saved) as ReturnType<typeof formOf>); }, [saved]);
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await attempt(async () => {
      await put("/api/settings", { maxConcurrentRuns: Number(f.maxConcurrentRuns), approverRole: f.approverRole, keepWorktreeDays: Number(f.keepWorktreeDays), newAccountRole: f.newAccountRole, usageThreshold: Number(f.usageThreshold) / 100, dailyBudgetUsd: Number(f.dailyBudgetUsd || 0), digestHour: Number(f.digestHour) });
      invalidate("/api/settings", "/api/board", "/api/status");
      me.refreshSession(); // the approver setting is part of the session
    }, "Settings saved");
    setBusy(false);
  };
  const dis = !canChange;
  return (
    <Section title="How the factory runs">
      <form className="form-panel form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="grid2">
          <Field label="Runs at once" hint="Across all projects. Each project also has its own limit."><Input type="number" min={1} max={20} value={f.maxConcurrentRuns} disabled={dis} onChange={(e) => setF({ ...f, maxConcurrentRuns: e.target.value })} className="num" /></Field>
          <Field label="Who may approve gates and reviews">
            <Select value={f.approverRole} disabled={dis} onChange={(e) => setF({ ...f, approverRole: e.target.value as Settings["approverRole"] })}>
              <option value="member">Members and admins</option>
              <option value="admin">Admins only</option>
            </Select>
          </Field>
          <Field label="Keep worktrees of finished requests (days)" hint="0 removes them as soon as a request finishes; the Changes tab needs the worktree."><Input type="number" min={0} max={90} value={f.keepWorktreeDays} disabled={dis} onChange={(e) => setF({ ...f, keepWorktreeDays: e.target.value })} className="num" /></Field>
          <Field label="New accounts" hint="For people not named in the server's .env.">
            <Select value={f.newAccountRole} disabled={dis} onChange={(e) => setF({ ...f, newAccountRole: e.target.value as Settings["newAccountRole"] })}>
              <option value="pending">Wait for an admin to let them in</option>
              <option value="viewer">Let them in as viewers</option>
            </Select>
          </Field>
          <Field label="Hold new runs when the plan window is used past (%)" hint="Five-hour window of the runner's subscription. The weekly window holds at 98%."><Input type="number" min={10} max={100} value={f.usageThreshold} disabled={dis} onChange={(e) => setF({ ...f, usageThreshold: e.target.value })} className="num" /></Field>
          <Field label="Daily budget ($)" hint="The factory stops starting new runs for the day when the API-equivalent spend reaches this. 0 is no cap.">
            <Input type="number" inputMode="decimal" min={0} max={10000} step="any" value={f.dailyBudgetUsd} disabled={dis} onChange={(e) => setF({ ...f, dailyBudgetUsd: e.target.value })} className="num" />
          </Field>
          <Field label="Daily digest" hint="A daily summary to Telegram and Slack status channels: what shipped, what waits on a person, what it cost.">
            <Select value={f.digestHour} disabled={dis} onChange={(e) => setF({ ...f, digestHour: e.target.value })}>
              <option value="-1">Off</option>
              {HOURS.map((h) => <option key={h} value={String(h)}>{h}:00</option>)}
            </Select>
          </Field>
        </div>
        {canChange && <div className="form-actions"><Button type="submit" disabled={busy}>Save settings</Button></div>}
      </form>
      {spend && <SpendToday spend={spend} />}
    </Section>
  );
}

/** Today's API-equivalent spend, against the daily budget when one is set. */
function SpendToday({ spend }: { spend: Spend }) {
  const { total, byProject } = spend.today;
  const budget = spend.dailyBudgetUsd;
  const share = budget > 0 ? total / budget : null;
  const other = total - byProject.reduce((n, p) => n + p.usd, 0);
  const parts = [...byProject.map((p) => `${p.name} ${money(p.usd)}`), ...(other >= 0.005 ? [`no project ${money(other)}`] : [])];
  return (
    <div className="usage spend">
      <div className="usage-head">
        <strong>Spend today</strong><span className="num spend-total">{money(total)}</span><span className="grow" />
        <span className="quiet num">{share == null ? "no daily budget" : share >= 1 ? `the ${money(budget)} daily budget is reached; new runs wait until tomorrow` : `${pct(share)} of the ${money(budget)} daily budget`}</span>
      </div>
      {share != null && <Meter value={share} warnAt={0.8} badAt={1} label="Spend today against the daily budget" />}
      <p className="quiet spend-by num">{parts.length ? parts.join(" · ") : "No run has finished since midnight."}</p>
    </div>
  );
}

function UsageRow({ runner, u, threshold }: { runner: string; u: Usage; threshold: number }) {
  const reset = u.resetsAt ? new Date(u.resetsAt * 1000).toISOString() : null;
  return (
    <div className="usage">
      <div className="usage-head"><strong>{runner}</strong>{u.status && u.status !== "allowed" && <span className="tag bad">{u.status}</span>}<span className="grow" /><span className="quiet">reported <Ago iso={u.at} /></span></div>
      {u.fiveHour != null && <div className="usage-line"><span>Five-hour window</span><Meter value={u.fiveHour} warnAt={threshold * 0.8} badAt={threshold} label="Five-hour window used" /><span className="num">{pct(u.fiveHour)}</span></div>}
      {u.sevenDay != null && <div className="usage-line"><span>Weekly window</span><Meter value={u.sevenDay} warnAt={0.8} badAt={0.98} label="Weekly window used" /><span className="num">{pct(u.sevenDay)}</span></div>}
      {reset && <p className="quiet">Resets {fmtDate(reset)} (<Ago iso={reset} />).</p>}
    </div>
  );
}

function Machinery({ d }: { d: SettingsData }) {
  const usage = Object.entries(d.usage);
  return (
    <>
      <Section title="Runners" hint={`default: ${d.defaultRunner}, ${d.model}; small jobs: ${d.smallModel}`}>
        <Group>
          {d.runners.map((r) => (
            <div className="row" key={r.id}>
              <Check ok={r.ok} />
              <div className="row-main">
                <div className="row-title">{r.label} <span className="mono quiet">{r.id}</span></div>
                <div className="row-sub">{r.version ?? r.detail ?? (r.ok ? "ready" : "not available")}{r.version && r.detail ? `, ${r.detail}` : ""}</div>
              </div>
              <div className="row-trailing caps">
                {Object.entries(r.capabilities).filter(([, v]) => v).map(([k]) => <span key={k} className="chip">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</span>)}
              </div>
            </div>
          ))}
        </Group>
      </Section>
      <Section title="Plan usage" hint={d.held ? `holding new runs: ${d.held}` : "what the runners last reported"}>
        {usage.length ? <div className="usages">{usage.map(([k, u]) => <UsageRow key={k} runner={k} u={u} threshold={d.settings.usageThreshold} />)}</div> : <p className="quiet">No runner has reported plan usage since the server started.</p>}
      </Section>
      <Section title="Connections">
        <Facts items={[
          ["Notifier", d.notifier.configured ? <span className="inline-tight"><Check ok={d.notifier.reachable} label={d.notifier.reachable ? `reachable, ${d.notifier.channels} channel${d.notifier.channels === 1 ? "" : "s"}` : `not reachable${d.notifier.error ? `: ${d.notifier.error}` : ""}`} />{d.notifier.url && <span className="mono quiet">{d.notifier.url}</span>}</span> : <span className="quiet">not configured (NOTIFIER_URL)</span>],
          ["Secret storage", <Check ok={d.encryption} label={d.encryption ? "FACTORY_SECRET is set" : "FACTORY_SECRET is not set; sources cannot store tokens"} />],
          ["Google sign-in", <Check ok={d.google} label={d.google ? "configured" : "not configured"} />],
          ["Data folder", <span className="mono">{d.dataDir}</span>],
        ]} />
      </Section>
    </>
  );
}

function Appearance() {
  const [t, setT] = useState<Theme>(savedTheme);
  return (
    <Section title="Appearance" hint="on this device">
      <Segmented label="Theme" value={t} onChange={(v) => { setT(v); saveTheme(v); }} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
    </Section>
  );
}

function Devices() {
  const { data, error } = useApi<DeviceSession[]>("/api/me/sessions");
  const others = (data ?? []).filter((s) => !s.current).length;
  return (
    <Section title="My devices" aside={others ? <Button size="sm" variant="secondary" onClick={() => { if (confirm(`Sign out ${others} other device${others === 1 ? "" : "s"}?`)) void attempt(async () => { const r = await del<{ revoked: number }>("/api/me/sessions/others"); invalidate("/api/me/sessions"); toast(`Signed out ${r.revoked} device${r.revoked === 1 ? "" : "s"}`); }); }}>Sign out the others</Button> : undefined}>
      {error && <p className="error">{error}</p>}
      {!data && !error && <Loading />}
      {data && (
        <Group>
          {data.map((s) => (
            <div className="row" key={s.id}>
              <div className="row-main">
                <div className="row-title">{s.device}{s.current && <span className="tag">this device</span>}</div>
                <div className="row-sub">{s.ip ?? "unknown address"}. Signed in {fmtDate(s.created_at, false)}, last seen <Ago iso={s.last_seen_at} />.</div>
              </div>
              {!s.current && <div className="row-trailing"><Button size="sm" variant="ghost" onClick={() => attempt(async () => { await del(`/api/me/sessions/${s.id}`); invalidate("/api/me/sessions"); }, "Signed out")}>Sign out</Button></div>}
            </div>
          ))}
        </Group>
      )}
    </Section>
  );
}

function Tokens() {
  const { data, error } = useApi<ApiToken[]>("/api/me/tokens");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const create = async () => {
    const n = name.trim();
    await attempt(async () => { const t = await post<{ id: number; token: string }>("/api/me/tokens", { name: n }); setCreated({ name: n, token: t.token }); setName(""); invalidate("/api/me/tokens"); });
  };
  return (
    <Section title="My API tokens" hint="for the command line and scripts; a token acts as you">
      {created && (
        <div className="token-once" role="status">
          <p><strong>{created.name}</strong> is ready. Copy it now: it is not shown again.</p>
          <div className="hook"><span className="mono hook-url">{created.token}</span><CopyButton text={created.token} /></div>
          <pre className="code">{`export FACTORY_URL=${location.origin}\nexport FACTORY_TOKEN=${created.token}\nfactory status`}</pre>
          <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>Done</Button>
        </div>
      )}
      <form className="inline token-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }}>
        <Input aria-label="Token name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Laptop CLI" maxLength={80} className="grow" />
        <Button type="submit" disabled={!name.trim()}>Create token</Button>
      </form>
      <p className="quiet">The CLI reads <span className="mono">FACTORY_URL</span> (this address, {location.origin}) and <span className="mono">FACTORY_TOKEN</span> from the environment.</p>
      {error && <p className="error">{error}</p>}
      {data && data.length > 0 && (
        <Group>
          {data.map((t) => (
            <div className="row" key={t.id}>
              <div className="row-main">
                <div className="row-title">{t.name} <span className="mono quiet">{t.prefix}…</span></div>
                <div className="row-sub">Created {fmtDate(t.created_at, false)}. {t.last_used_at ? <>Last used <Ago iso={t.last_used_at} />.</> : "Never used."}</div>
              </div>
              <div className="row-trailing"><Button size="sm" variant="danger" onClick={() => { if (confirm(`Revoke ${t.name}? Anything using it stops working.`)) void attempt(async () => { await del(`/api/me/tokens/${t.id}`); invalidate("/api/me/tokens"); }, "Token revoked"); }}>Revoke</Button></div>
            </div>
          ))}
        </Group>
      )}
    </Section>
  );
}
