import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invalidate, invalidateKey, post, useApi } from "../lib/api";
import { useMe } from "../lib/session";
import type { Candidate, Discovery, Gates, Project, ProjectDefaults } from "../lib/types";
import { Button, ButtonLink, Empty, ErrorNote, Facts, Field, Group, Input, Loading, Page, Row, Segmented, Select, Sheet, Textarea, toast } from "../components/ui";
import { Icon } from "../components/icons";
import { GATE_HELP, GATE_OPTIONS, OPTION_LABEL, toSlug } from "./ProjectEdit";

const DISCOVER = "/api/projects/discover";

export default function Projects() {
  const me = useMe();
  const { data, error, reload } = useApi<Project[]>("/api/projects");
  const [finding, setFinding] = useState(false);
  // Look again on every open: a folder cloned since the last look should be offered.
  const find = () => { invalidateKey(DISCOVER); setFinding(true); };
  const fromMac = <Button variant="secondary" onClick={find}>Add from this Mac</Button>;
  return (
    <Page title="Projects" subtitle="The repositories the factory may work on: how to test, build and ship each, which gates a person opens, and how much an agent may spend."
      aside={me.isAdmin ? <>{fromMac}<ButtonLink to="/projects/new" variant="primary"><Icon name="plus" />New project</ButtonLink></> : undefined}>
      {error && <ErrorNote error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && !data.length && <Empty title="No projects yet" hint="A project points the factory at a repository, by URL or by a path on this machine. Requests need one before they can be planned."
        action={me.isAdmin ? <div className="inline">{fromMac}<ButtonLink to="/projects/new" variant="primary">Add a project</ButtonLink></div> : undefined} />}
      {data && data.length > 0 && (
        <Group>
          {data.map((p) => (
            <Row key={p.id} to={`/projects/${p.id}`}
              title={<span className="inline-tight">{p.name}<span className="mono quiet">{p.slug}</span>{p.paused && <span className="pill f-wait st"><span className="lamp" aria-hidden="true" />paused</span>}</span>}
              subtitle={<span className="mono">{p.repo_url ?? p.local_path}</span>}
              trailing={<>
                <span className="tag">{p.delivery === "pr" ? "pull requests" : "local merge"}</span>
                <span className="num"><strong>{p.open ?? 0}</strong> open</span>
                <span className="num quiet">{p.done ?? 0} done</span>
              </>} />
          ))}
        </Group>
      )}
      {finding && <DiscoverSheet onClose={() => setFinding(false)} />}
    </Page>
  );
}

// ---------- add from this Mac ----------

function DiscoverSheet({ onClose }: { onClose: () => void }) {
  const [picked, setPicked] = useState<Candidate | null>(null);
  if (picked) return <RegisterForm c={picked} onBack={() => setPicked(null)} onClose={onClose} />;
  return <CandidateList onPick={setPicked} onClose={onClose} />;
}

const Roots = ({ roots }: { roots: string[] }) => <>{roots.map((r, i) => <span key={r}>{i ? (i === roots.length - 1 ? " or " : ", ") : ""}<span className="mono">{r}</span></span>)}</>;

function CandidateList({ onPick, onClose }: { onPick: (c: Candidate) => void; onClose: () => void }) {
  const { data, error, reload } = useApi<Discovery>(DISCOVER);
  return (
    <Sheet open onClose={onClose} title="Add from this Mac" wide>
      {error && <ErrorNote error={error} onRetry={reload} />}
      {!data && !error && <Loading label="Looking for repositories" />}
      {data && !data.candidates.length && (
        <Empty title={<>Nothing new under <Roots roots={data.roots} />.</>} hint="Every git checkout there is a project already. A repository somewhere else can still be added by its path."
          action={<ButtonLink to="/projects/new">New project</ButtonLink>} />
      )}
      {data && data.candidates.length > 0 && (
        <>
          <p className="quiet">Git checkouts under <Roots roots={data.roots} /> that are not projects yet. Pick one to check what was guessed from its files before adding it.</p>
          <Group>{data.candidates.map((c) => <CandidateRow key={c.path} c={c} onPick={() => onPick(c)} />)}</Group>
        </>
      )}
    </Sheet>
  );
}

/** "github.com" out of git@github.com:a/b.git or https://host/a/b; null for a path. */
function remoteHost(remote: string): string | null {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^/:\s]+\.[^/:\s]+)[:/]/i.exec(remote)?.[1] ?? null;
}
function RemoteTag({ c }: { c: Candidate }) {
  if (c.github) return <span className="tag" title={c.remote ?? undefined}><Icon name="github" size={12} />{c.github}</span>;
  if (c.remote) return <span className="tag" title={c.remote}>{remoteHost(c.remote) ?? "remote"}</span>;
  return <span className="tag">no remote</span>;
}

function CandidateRow({ c, onPick }: { c: Candidate; onPick: () => void }) {
  const s = c.suggestions;
  const cmds = ([["test", s.test_command], ["build", s.build_command], ["deploy", s.deploy_command]] as const).filter(([, v]) => v);
  return (
    <Row onClick={onPick}
      title={<>{c.name}<RemoteTag c={c} /></>}
      subtitle={<span className="mono">{c.path}</span>}
      block={<div className="cand-cmds">{cmds.length
        ? cmds.map(([k, v]) => <span key={k}>{k} <span className="mono">{v}</span></span>)
        : <span>No test, build or deploy command found</span>}</div>}
      trailing={<><span className="mono" title="Branch checked out now">{c.default_branch}</span><span className="chevron" aria-hidden="true">›</span></>} />
  );
}

type RForm = { name: string; slug: string; default_branch: string; setup_command: string; test_command: string; build_command: string; deploy_command: string; health_url: string; instructions: string; delivery: "local" | "pr";
  /** null until a gate is changed: the factory's defaults apply. */
  gates: Gates | null };
const orNull = (s: string) => (s.trim() ? s.trim() : null);
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function RegisterForm({ c, onBack, onClose }: { c: Candidate; onBack: () => void; onClose: () => void }) {
  const navigate = useNavigate();
  const formId = useId();
  const { data: defaults } = useApi<ProjectDefaults>("/api/projects/defaults");
  const s = c.suggestions;
  const [f, setF] = useState<RForm>(() => ({
    name: c.name, slug: c.slug, default_branch: c.default_branch, setup_command: s.setup_command ?? "", test_command: s.test_command ?? "", build_command: s.build_command ?? "", deploy_command: s.deploy_command ?? "",
    health_url: s.health_url ?? "", instructions: s.instructions ?? "", delivery: "local", gates: null,
  }));
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const gates = f.gates ?? defaults?.gates ?? null;
  const text = (k: Exclude<keyof RForm, "delivery" | "gates">) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const slugOk = SLUG.test(f.slug);
  const ok = Boolean(f.name.trim()) && slugOk;

  const save = async () => {
    if (!ok || busy) return;
    setBusy(true); setErr("");
    try {
      const p = await post<Project>("/api/projects/discover/register", {
        path: c.path, slug: f.slug, name: f.name.trim(),
        overrides: {
          setup_command: orNull(f.setup_command), test_command: orNull(f.test_command), build_command: orNull(f.build_command), deploy_command: orNull(f.deploy_command),
          health_url: orNull(f.health_url), instructions: orNull(f.instructions), default_branch: f.default_branch.trim() || c.default_branch, delivery: f.delivery, ...(gates ? { gates } : {}),
        },
      });
      invalidate("/api/projects", "/api/board");
      toast(`${p.name} added`);
      onClose();
      navigate(`/projects/${p.id}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} title={`Add ${c.name}`} wide
      footer={<>
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" form={formId} disabled={!ok || busy}>{busy ? "Adding…" : "Add project"}</Button>
      </>}>
      <form id={formId} className="form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Facts items={[
          ["Folder", <span className="mono">{c.path}</span>],
          ["Remote", c.remote ? <span className="mono">{c.github ?? c.remote}</span> : <span className="quiet">none</span>],
        ]} />
        <div className="grid2">
          <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: slugTouched ? f.slug : toSlug(e.target.value) })} maxLength={100} /></Field>
          <Field label="Slug" required hint={slugOk || !f.slug ? "Used in branch names and chat commands." : "Only lowercase letters, digits and dashes, starting with a letter or digit."}>
            <Input value={f.slug} onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: e.target.value }); }} maxLength={63} className="mono-input" aria-invalid={Boolean(f.slug) && !slugOk} />
          </Field>
        </div>
        <p className="quiet">The commands below were guessed from the repository's files. Change any of them; leave one empty to skip that step.</p>
        <div className="grid2">
          <Field label="Setup" hint="Once per worktree, before building."><Input {...text("setup_command")} className="mono-input" placeholder="npm ci" /></Field>
          <Field label="Test" hint="Must pass before review."><Input {...text("test_command")} className="mono-input" placeholder="npm test" /></Field>
          <Field label="Build" hint="Must pass before review."><Input {...text("build_command")} className="mono-input" placeholder="npm run build" /></Field>
          <Field label="Deploy" hint="After merging, when the deploy gate opens."><Input {...text("deploy_command")} className="mono-input" placeholder="make deploy" /></Field>
        </div>
        <Field label="Health URL" hint="Watched after a deploy; two failed checks block the request."><Input {...text("health_url")} className="mono-input" placeholder="http://127.0.0.1:4100/api/healthz" /></Field>
        <Field label="Instructions" hint="House rules added to every prompt. Prefilled with the README's first paragraph when there is one.">
          <Textarea rows={4} {...text("instructions")} maxLength={20000} />
        </Field>
        <div className="grid2">
          <Field label="Default branch" hint="The branch checked out there now. Work starts from it and lands back on it.">
            <Input {...text("default_branch")} maxLength={100} className="mono-input" />
          </Field>
          {c.remote
            ? <Field group label="Delivery" hint={f.delivery === "pr" ? `Pushes a branch to ${c.github ?? "the remote"} and opens a pull request.` : "Merges on this Mac; nothing is pushed."}>
                <Segmented label="Delivery" value={f.delivery} onChange={(v) => setF({ ...f, delivery: v })} options={[{ value: "local", label: "Local merge" }, { value: "pr", label: "Pull request" }]} />
              </Field>
            : <Field group label="Delivery" hint="No remote, so changes are merged on this Mac; nothing is pushed."><span>Local merge</span></Field>}
        </div>
        {gates && (
          <Field group label="Gates" hint="Where a person must say yes before the factory goes on. Limits and tools start at the defaults; edit the project to change them.">
            <div className="gate-grid">
              {(Object.keys(GATE_OPTIONS) as Array<keyof Gates>).map((g) => (
                <Field key={g} label={g === "review" ? "AI review" : `${g[0].toUpperCase()}${g.slice(1)}`} hint={GATE_HELP[g][gates[g]]}>
                  <Select value={gates[g]} onChange={(e) => setF({ ...f, gates: { ...gates, [g]: e.target.value } as Gates })}>
                    {GATE_OPTIONS[g].map((o) => <option key={o} value={o}>{OPTION_LABEL[o]}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
          </Field>
        )}
        {err && <p className="error" role="alert">{err}</p>}
      </form>
    </Sheet>
  );
}
