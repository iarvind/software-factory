import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { del, invalidate, post, useApi } from "../lib/api";
import { money } from "../lib/format";
import { useMe } from "../lib/session";
import type { Item, Note, Project, ProjectCheck } from "../lib/types";
import { Ago, Button, ButtonLink, Check, Empty, ErrorNote, Facts, Group, Loading, Page, Row, Section, attempt, useBusy } from "../components/ui";
import { StatusPill } from "../components/status";
import { NoteComposer, NoteRow } from "./Book";
import { GATE_HELP } from "./ProjectEdit";

export default function ProjectPage() {
  const { id } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const { data: p, error, reload } = useApi<Project>(`/api/projects/${id}`);
  const { data: items } = useApi<Item[]>(`/api/items?project=${id}&limit=60`);
  const { data: notes } = useApi<Note[]>(`/api/projects/${id}/notes`);
  const [check, setCheck] = useState<ProjectCheck | null>(null);
  const [checking, wrap] = useBusy();

  if (error && !p) return <Page title="Project"><ErrorNote error={error} onRetry={reload} /></Page>;
  if (!p) return <Page title="Project"><Loading /></Page>;

  const runCheck = async () => {
    setCheck(null);
    try { setCheck(await wrap(post<ProjectCheck>(`/api/projects/${p.id}/check`))); }
    catch (e) { setCheck({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
  };
  const remove = async () => {
    if (!confirm(`Delete the project ${p.name}? Its finished requests stay, without a project.`)) return;
    if (await attempt(async () => { await del(`/api/projects/${p.id}`); invalidate("/api/projects", "/api/board"); }, "Project deleted")) navigate("/projects");
  };
  const observe = p.limits.observeMinutes ?? 2;
  const open = (items ?? []).filter((i) => !["done", "failed", "cancelled"].includes(i.status));
  const closed = (items ?? []).filter((i) => ["done", "failed", "cancelled"].includes(i.status));

  return (
    <Page title={p.name} subtitle={p.description ?? undefined}
      aside={<>
        {me.canEdit && <Button variant="secondary" onClick={runCheck} disabled={checking}>{checking ? "Checking…" : "Check"}</Button>}
        {me.canEdit && <ButtonLink to={`/projects/${p.id}/edit`}>Edit</ButtonLink>}
      </>}>
      {p.paused && <div className="banner wait">Paused: new requests for this project wait until it is resumed.</div>}
      {check && <CheckResult check={check} />}
      <Section first title="How it works">
        <Facts items={[
          ["Slug", <span className="mono">{p.slug}</span>],
          ["Repository", <span className="mono">{p.repo_url ?? p.local_path}</span>],
          ["Default branch", <span className="mono">{p.default_branch}</span>],
          ["Delivery", p.delivery === "pr" ? "Pull requests" : "Merged locally"],
          ["Runner", <>{p.runner ?? "default"}{p.model ? `, ${p.model}` : ""}{p.effort ? `, effort ${p.effort}` : ""}</>],
          ["Tools", <>{p.tools.mode}{p.tools.allow.length ? `, ${p.tools.allow.length} allowed` : ""}{p.tools.deny.length ? `, ${p.tools.deny.length} denied` : ""}{p.tools.dirs?.length ? `, ${p.tools.dirs.length} folder${p.tools.dirs.length === 1 ? "" : "s"} to read` : ""}{Object.keys(p.tools.mcp ?? {}).length ? `, MCP: ${Object.keys(p.tools.mcp).join(", ")}` : ""}</>],
          ["Test", p.test_command ? <span className="mono">{p.test_command}</span> : <span className="quiet">none</span>],
          ["Build", p.build_command ? <span className="mono">{p.build_command}</span> : <span className="quiet">none</span>],
          ["Deploy", p.deploy_command ? <span className="mono">{p.deploy_command}</span> : <span className="quiet">none</span>],
          p.health_url ? ["Health", <span className="mono">{p.health_url}</span>] : null,
          ["Env", p.env.length ? <span className="mono">{p.env.join(", ")}</span> : <span className="quiet">none</span>],
        ]} />
      </Section>
      <Section title="Gates and limits">
        <div className="gates">
          {(["plan", "merge", "deploy", "review"] as const).map((g) => (
            <div key={g} className="gate"><div className="gate-name">{g}</div><div className="gate-value">{p.gates[g].replace(/_/g, " ")}</div><div className="quiet">{GATE_HELP[g][p.gates[g]]}</div></div>
          ))}
        </div>
        <p className="quiet limits-line num">
          Up to {p.limits.maxTurns} turns, {money(p.limits.maxBudgetUsd)} and {p.limits.maxMinutes} min per run; {p.limits.maxFixRounds} fix rounds; {p.limits.concurrency} at a time; tests get {p.limits.verifyMinutes} min; at most {p.limits.maxInReview} waiting in review; {observe ? <>the health URL is watched {observe} min after a deploy{p.health_url ? "" : " (none is set)"}</> : "the health URL is not watched after a deploy"}.
        </p>
      </Section>
      <Section title="Open requests" hint={`${open.length}`}>
        {items ? open.length ? <Group>{open.map((i) => <ItemRow key={i.id} i={i} />)}</Group> : <Empty title="Nothing open" hint="New requests for this project appear here." /> : <Loading />}
      </Section>
      {closed.length > 0 && <Section title="Finished" hint="most recent first"><Group>{closed.slice(0, 20).map((i) => <ItemRow key={i.id} i={i} />)}</Group></Section>}
      <Section title="The book" hint="What earlier jobs learned about this repository; every new run reads the latest notes.">
        {me.canEdit && <NoteComposer projectId={p.id} />}
        {notes ? notes.length ? <Group>{notes.map((n) => <NoteRow key={n.id} n={n} />)}</Group> : <p className="quiet">No notes yet. Agents add one after each job; you can too.</p> : <Loading />}
      </Section>
      {me.isAdmin && <Section title="Danger"><Button variant="danger" onClick={remove}>Delete project</Button><p className="quiet">Only possible when no open request points at it.</p></Section>}
    </Page>
  );
}

function ItemRow({ i }: { i: Item }) {
  return <Row to={`/items/${i.id}`} leading={<span className="num quiet id-col">#{i.id}</span>} title={i.title} subtitle={<>{i.requester_name ?? ""} <Ago iso={i.updated_at} /></>} trailing={<StatusPill status={i.status} gate={i.gate} />} />;
}

const CHECK_LABEL: Record<string, string> = {
  exists: "Folder exists", git: "Is a git repository", remote: "Has a remote", defaultBranch: "Default branch found", clean: "Working tree clean", cloned: "Already cloned",
  remoteReachable: "Remote reachable", gh: "GitHub CLI signed in", github: "GitHub repository", base: "Base ref", dir: "Folder",
};
export function CheckResult({ check }: { check: ProjectCheck }) {
  const entries = Object.entries(check).filter(([k]) => k !== "ok" && k !== "error");
  return (
    <div className={`check-result ${check.ok ? "ok" : "no"}`} role="status">
      <div className="check-title"><Check ok={Boolean(check.ok)} label={check.ok ? "The factory can work on this project." : "Something needs fixing before the factory can work here."} /></div>
      {check.error && <p className="error">{check.error}</p>}
      <ul>
        {entries.map(([k, v]) => <li key={k}>{typeof v === "boolean" ? <Check ok={v} label={CHECK_LABEL[k] ?? k} /> : <span><span className="quiet">{CHECK_LABEL[k] ?? k}: </span><span className="mono">{v == null ? "—" : String(v)}</span></span>}</li>)}
      </ul>
    </div>
  );
}

