import { useMemo, useState } from "react";
import { del, invalidate, patch, post, useApi } from "../lib/api";
import { plural } from "../lib/format";
import { useMe } from "../lib/session";
import type { BoardData, Field as FieldDef, Source, SourceKind, SourceKinds } from "../lib/types";
import { Ago, Banner, Button, CopyButton, Empty, ErrorNote, Field, Input, Loading, Page, Section, Segmented, Select, Sheet, Textarea, Toggle, attempt, toast } from "../components/ui";
import { Icon } from "../components/icons";
import { Lamp } from "../components/status";

const every = (s: number) => (s % 3600 === 0 ? `every ${plural(s / 3600, "hour")}` : s % 60 === 0 ? `every ${s / 60} min` : `every ${s} s`);
const hookUrl = (s: Source) => (s.config.hookToken ? `${location.origin}/api/hooks/${String(s.config.hookToken)}` : null);

export default function Sources() {
  const me = useMe();
  const { data: sources, error, reload } = useApi<Source[]>("/api/sources");
  const { data: kinds } = useApi<SourceKinds>("/api/sources/kinds");
  const { data: board } = useApi<BoardData>("/api/board");
  const [editing, setEditing] = useState<Source | "new" | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, Source[]>();
    for (const s of sources ?? []) m.set(s.kind, [...(m.get(s.kind) ?? []), s]);
    return [...m.entries()];
  }, [sources]);
  const kindLabel = (k: string) => kinds?.kinds.find((x) => x.kind === k)?.label ?? k;
  const projects = new Map((board?.projects ?? []).map((p) => [p.id, p.name]));

  return (
    <Page title="Sources" subtitle="Where work comes from: chat threads, tickets, issues, schedules, watches on running services, and webhooks. Each one turns what it finds into requests and reports back where they came from."
      aside={me.isAdmin ? <Button onClick={() => setEditing("new")}><Icon name="plus" />Add source</Button> : undefined}>
      {kinds && !kinds.encryption && <Banner tone="wait"><strong>Secrets cannot be stored yet.</strong> Set FACTORY_SECRET in the server's .env and restart it; until then sources that need a token (Slack, Jira, GitHub) cannot be saved with one.</Banner>}
      {error && <ErrorNote error={error} onRetry={reload} />}
      {!sources && !error && <Loading />}
      {sources && !sources.length && <Empty title="No sources yet" hint="Requests can still come in from the form and the API. Add a source to take work from Slack, Jira, GitHub, a schedule or a webhook." action={me.isAdmin ? <Button onClick={() => setEditing("new")}>Add a source</Button> : undefined} />}
      {groups.map(([kind, list], i) => (
        <Section key={kind} first={i === 0} title={kindLabel(kind)} hint={plural(list.length, "source")}>
          <div className="sources">{list.map((s) => <SourceCard key={s.id} s={s} project={s.project_id ? projects.get(s.project_id) : undefined} onEdit={() => setEditing(s)} />)}</div>
        </Section>
      ))}
      {editing && kinds && <SourceSheet kinds={kinds} source={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function SourceCard({ s, project, onEdit }: { s: Source; project?: string; onEdit: () => void }) {
  const me = useMe();
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [busy, setBusy] = useState("");
  const fam = !s.enabled ? "idle" : s.last_error || s.live === "error" ? "bad" : s.live || s.last_ok_at ? "done" : "wait";
  const state = !s.enabled ? "Off" : s.live === "error" ? "Not connected" : s.last_error ? "Failing" : s.live ? "Connected" : s.last_ok_at ? "Working" : "Not polled yet";
  const url = s.adapter?.webhook ? hookUrl(s) : null;
  const run = async (what: "test" | "poll") => {
    setBusy(what); setResult(null);
    try {
      if (what === "test") setResult(await post<{ ok: boolean; detail: string }>(`/api/sources/${s.id}/test`));
      else { const r = await post<{ ok: boolean; error: string | null }>(`/api/sources/${s.id}/poll`); setResult({ ok: r.ok, detail: r.ok ? "Polled; anything new is on the board." : r.error ?? "The poll failed." }); invalidate("/api/sources", "/api/board"); }
    } catch (e) { setResult({ ok: false, detail: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(""); }
  };
  const remove = () => { if (confirm(`Delete the source ${s.name}? Requests it created stay.`)) void attempt(async () => { await del(`/api/sources/${s.id}`); invalidate("/api/sources"); }, "Source deleted"); };
  return (
    <article className="source">
      <div className="source-head">
        <Lamp family={fam} />
        <h3>{s.name}</h3>
        <span className="quiet">{state}</span>
        <span className="grow" />
        {me.isAdmin && <Toggle checked={s.enabled} label={s.enabled ? `Turn off ${s.name}` : `Turn on ${s.name}`} onChange={(v) => attempt(async () => { await patch(`/api/sources/${s.id}`, { enabled: v }); invalidate("/api/sources"); }, v ? "Turned on" : "Turned off")} />}
      </div>
      <dl className="source-facts">
        <div><dt>Project</dt><dd>{project ?? <span className="quiet">decided per request</span>}</dd></div>
        {(s.adapter?.polls ?? true) && !s.adapter?.webhook && <div><dt>Runs</dt><dd className="num">{s.cron ? <span className="mono">{s.cron}</span> : s.interval_sec ? every(s.interval_sec) : <span className="quiet">default</span>}</dd></div>}
        {s.adapter?.polls && <div><dt>Last polled</dt><dd>{s.last_polled_at ? <Ago iso={s.last_polled_at} /> : <span className="quiet">never</span>}</dd></div>}
        <div><dt>Last OK</dt><dd>{s.last_ok_at ? <Ago iso={s.last_ok_at} /> : <span className="quiet">never</span>}</dd></div>
        {s.adapter?.longLived && <div><dt>Connection</dt><dd>{s.live === "connected" ? "connected" : s.live === "error" ? "failed; retrying" : "not connected"}</dd></div>}
        {Object.keys(s.secrets).length > 0 && <div><dt>Secrets</dt><dd className="mono">{Object.entries(s.secrets).map(([k, v]) => `${k} ${v}`).join(", ")}</dd></div>}
      </dl>
      {s.last_error && <p className="error source-error">{s.last_error}</p>}
      {url && <div className="hook"><span className="mono hook-url">{url}</span><CopyButton text={url} label="Copy URL" /></div>}
      {result && <p className={result.ok ? "ok-note" : "error"} role="status">{result.detail}</p>}
      {me.canEdit && (
        <div className="source-actions">
          <Button size="sm" variant="secondary" onClick={() => run("test")} disabled={Boolean(busy)}>{busy === "test" ? "Testing…" : "Test"}</Button>
          {s.adapter?.polls && <Button size="sm" variant="secondary" onClick={() => run("poll")} disabled={Boolean(busy)}>{busy === "poll" ? "Polling…" : "Poll now"}</Button>}
          {me.isAdmin && <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button>}
          <span className="grow" />
          {me.isAdmin && <Button size="sm" variant="danger" onClick={remove}>Delete</Button>}
        </div>
      )}
    </article>
  );
}

// ---------- add / edit ----------

type Timing = "interval" | "cron" | "none";
type SForm = { kind: string; name: string; projectId: string; config: Record<string, unknown>; secrets: Record<string, string>; timing: Timing; interval: string; cron: string; enabled: boolean };

function initial(k: SourceKind, s: Source | null): SForm {
  const config: Record<string, unknown> = { ...(s?.config ?? {}) };
  if (!s) for (const f of k.fields) if (!f.secret && f.default !== undefined) config[f.key] = f.default;
  const timing: Timing = !k.polls ? "none" : s?.cron ? "cron" : s?.interval_sec ? "interval" : k.defaultIntervalSec ? "interval" : "cron";
  return {
    kind: k.kind, name: s?.name ?? "", projectId: s?.project_id ? String(s.project_id) : "", config, secrets: {}, timing,
    interval: String(s?.interval_sec ?? k.defaultIntervalSec ?? 300), cron: s?.cron ?? (k.kind === "schedule" ? "0 3 * * *" : ""), enabled: s?.enabled ?? true,
  };
}

function SourceSheet({ kinds, source, onClose }: { kinds: SourceKinds; source: Source | null; onClose: () => void }) {
  const [kind, setKind] = useState<SourceKind | null>(source ? kinds.kinds.find((k) => k.kind === source.kind) ?? null : null);
  if (source && !kind) return <Sheet open onClose={onClose} title="Edit source"><p className="error">This source's kind ({source.kind}) is not loaded on the server any more.</p></Sheet>;
  if (!kind) {
    return (
      <Sheet open onClose={onClose} title="Add a source" wide>
        <p className="quiet">Pick where the work comes from.</p>
        <div className="kinds">
          {kinds.kinds.map((k) => (
            <button key={k.kind} type="button" className="kind" onClick={() => setKind(k)}>
              <span className="kind-ico"><Icon name={k.kind} size={18} /></span>
              <span className="grow"><strong>{k.label}</strong><span className="quiet">{k.description}</span></span>
            </button>
          ))}
        </div>
      </Sheet>
    );
  }
  return <SourceForm kind={kind} source={source} encryption={kinds.encryption} onBack={source ? undefined : () => setKind(null)} onClose={onClose} />;
}

function SourceForm({ kind, source, encryption, onBack, onClose }: { kind: SourceKind; source: Source | null; encryption: boolean; onBack?: () => void; onClose: () => void }) {
  const { data: board } = useApi<BoardData>("/api/board");
  const [f, setF] = useState<SForm>(() => initial(kind, source));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const setConfig = (key: string, v: unknown) => setF({ ...f, config: { ...f.config, [key]: v } });
  const missing = kind.fields.filter((x) => x.required && (x.secret ? !source?.secrets[x.key] && !f.secrets[x.key] : f.config[x.key] == null || f.config[x.key] === ""));
  const intervalOk = f.timing !== "interval" || Number(f.interval) >= 15;
  const cronOk = f.timing !== "cron" || f.cron.trim().split(/\s+/).length >= 5;
  const ok = Boolean(f.name.trim()) && !missing.length && intervalOk && cronOk;
  const url = source && kind.webhook ? hookUrl(source) : null;

  const save = async () => {
    setBusy(true); setErr("");
    const config: Record<string, unknown> = { ...f.config };
    for (const x of kind.fields) {
      if (x.secret) { delete config[x.key]; continue; }
      if (x.kind === "number") { const v = config[x.key]; if (v === "" || v == null) delete config[x.key]; else config[x.key] = Number(v); }
    }
    const secrets = Object.fromEntries(Object.entries(f.secrets).filter(([, v]) => v !== undefined));
    const timing = f.timing === "interval" ? { intervalSec: Math.round(Number(f.interval)), cron: null } : f.timing === "cron" ? { intervalSec: null, cron: f.cron.trim() } : {};
    const body = { name: f.name.trim(), projectId: f.projectId ? Number(f.projectId) : null, config, ...(Object.keys(secrets).length ? { secrets } : {}), ...timing, enabled: f.enabled };
    try {
      if (source) await patch(`/api/sources/${source.id}`, body);
      else await post("/api/sources", { kind: kind.kind, ...body });
      invalidate("/api/sources");
      toast(source ? "Source saved" : "Source added");
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} title={source ? `Edit ${source.name}` : `New ${kind.label.toLowerCase()} source`} wide
      footer={<>
        {onBack && <Button variant="ghost" onClick={onBack}>Back</Button>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!ok || busy}>{busy ? "Saving…" : source ? "Save" : "Add source"}</Button>
      </>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (ok) void save(); }}>
        <p className="quiet">{kind.description}</p>
        {kind.help && <SetupHelp text={kind.help} open={!source} />}
        <div className="grid2">
          <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} placeholder={`${kind.label} for the team`} /></Field>
          <Field label="Project" hint="Requests from here go to this project.">
            <Select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
              <option value="">Decide per request</option>
              {(board?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        </div>
        {url && <div className="hook"><span className="mono hook-url">{url}</span><CopyButton text={url} label="Copy URL" /></div>}
        {kind.fields.map((x) => (
          <DynamicField key={x.key} def={x} value={f.config[x.key]} onChange={(v) => setConfig(x.key, v)}
            secret={x.secret ? { saved: source?.secrets[x.key], value: f.secrets[x.key], encryption, onChange: (v) => setF({ ...f, secrets: { ...f.secrets, [x.key]: v } }), onClear: () => { const s = { ...f.secrets }; if (source?.secrets[x.key]) s[x.key] = ""; else delete s[x.key]; setF({ ...f, secrets: s }); } } : undefined}
            readOnly={kind.webhook && x.key === "hookToken"} creating={!source} />
        ))}
        {kind.polls && (
          <Field group label="When to check" hint={f.timing === "cron" ? "Five fields: minute hour day month weekday, in the server's time zone. 0 3 * * * is every night at three." : "At least 15 seconds."}>
            <div className="inline">
              <Segmented label="Timing" value={f.timing as "interval" | "cron"} onChange={(v) => setF({ ...f, timing: v })} options={[{ value: "interval", label: "Every few seconds" }, { value: "cron", label: "On a cron schedule" }]} />
              {f.timing === "interval"
                ? <span className="inline"><Input type="number" min={15} max={604800} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })} className="num narrow" aria-label="Seconds between checks" aria-invalid={!intervalOk} /><span className="quiet">seconds</span></span>
                : <Input value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} className="mono-input narrow-wide" aria-label="Cron expression" placeholder="0 3 * * *" aria-invalid={!cronOk} />}
            </div>
          </Field>
        )}
        <label className="inline field"><Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Enabled" /><span>{f.enabled ? "On: it starts taking work once saved." : "Off: saved, but it does nothing until turned on."}</span></label>
        {missing.length > 0 && <p className="quiet">Still needed: {missing.map((m) => m.label).join(", ")}.</p>}
        {err && <p className="error" role="alert">{err}</p>}
        {!source && kind.webhook && <p className="quiet">The hook URL is generated when you save. Copy it from the source's card.</p>}
      </form>
    </Sheet>
  );
}

/** The kind's own setup steps, kept exactly as written so a manifest can be pasted as is. */
function SetupHelp({ text, open }: { text: string; open: boolean }) {
  return (
    <details className="setup-help" open={open}>
      <summary>How to set this up</summary>
      <div className="setup-help-body">
        <div className="setup-help-actions"><CopyButton text={text} /></div>
        <pre className="code setup">{text}</pre>
      </div>
    </details>
  );
}

type SecretProps = { saved?: string; value?: string; encryption: boolean; onChange: (v: string) => void; onClear: () => void };

function DynamicField({ def, value, onChange, secret, readOnly, creating }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void; secret?: SecretProps; readOnly?: boolean; creating: boolean }) {
  if (readOnly && creating) return null;
  const label = def.label;
  if (secret) {
    const cleared = secret.value === "" && Boolean(secret.saved);
    return (
      <Field label={label} required={def.required} hint={!secret.encryption ? "Needs FACTORY_SECRET on the server before it can be stored." : def.help ?? (secret.saved ? "Saved. Type a new value to replace it." : "Stored encrypted; shown only as its last four characters.")}>
        <div className="inline">
          <Input type="password" autoComplete="new-password" className="grow mono-input" disabled={!secret.encryption} value={cleared ? "" : secret.value ?? ""}
            placeholder={cleared ? "will be removed on save" : secret.saved ?? def.placeholder ?? ""} onChange={(e) => secret.onChange(e.target.value)} />
          {(secret.saved || secret.value) && <Button size="sm" variant="ghost" onClick={secret.onClear}>{cleared ? "Removed" : "Clear"}</Button>}
        </div>
      </Field>
    );
  }
  const v = value == null ? "" : value;
  if (def.kind === "boolean") return <label className="inline field"><Toggle checked={Boolean(value)} onChange={onChange} label={label} /><span>{label}{def.help && <span className="field-hint block">{def.help}</span>}</span></label>;
  const common = { placeholder: def.placeholder, readOnly, "aria-required": def.required };
  return (
    <Field label={label} required={def.required} hint={def.help}>
      {def.kind === "textarea" ? <Textarea rows={4} value={String(v)} onChange={(e) => onChange(e.target.value)} {...common} />
        : def.kind === "select" ? (
          <Select value={String(v)} onChange={(e) => onChange(e.target.value)} aria-required={def.required}>
            {!def.required && <option value="">None</option>}
            {(def.options ?? []).map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
          </Select>
        )
        : def.kind === "number" ? <Input type="number" value={String(v)} onChange={(e) => onChange(e.target.value)} {...common} className="num" />
        : <Input value={String(v)} onChange={(e) => onChange(e.target.value)} {...common} className={readOnly ? "mono-input" : undefined} />}
    </Field>
  );
}

