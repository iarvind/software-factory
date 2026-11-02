import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { invalidate, patch, post, useApi } from "../lib/api";
import { splitLines } from "../lib/format";
import { useMe } from "../lib/session";
import type { Gates, Limits, McpServer, Project, ProjectDefaults } from "../lib/types";
import { Button, Empty, ErrorNote, Field, Input, Loading, Page, Segmented, Select, Textarea, Toggle, toast } from "../components/ui";

export const GATE_HELP: Record<keyof Gates, Record<string, string>> = {
  plan: { manual: "A person approves every plan before building starts.", auto: "Building starts as soon as a plan is ready.", auto_low_risk: "Low and medium risk plans go ahead; high risk waits for a person." },
  merge: { manual: "A person approves every merge.", auto: "Merges as soon as the review passes.", auto_low_risk: "Merges by itself unless the change is high risk." },
  deploy: { manual: "A person starts every deploy.", auto: "Deploys right after merging.", off: "Never deploys; merging is the end of the line." },
  review: { ai: "A second agent reviews every change before a person sees it.", off: "No AI review; the change goes straight to a person." },
};
export const GATE_OPTIONS: Record<keyof Gates, string[]> = { plan: ["manual", "auto", "auto_low_risk"], merge: ["manual", "auto", "auto_low_risk"], deploy: ["manual", "auto", "off"], review: ["ai", "off"] };
export const OPTION_LABEL: Record<string, string> = { manual: "A person", auto: "Automatic", auto_low_risk: "Automatic unless high risk", off: "Off", ai: "AI reviewer" };

/** `def` fills a limit a server older than the field did not send. */
const LIMITS: Array<{ key: keyof Limits; label: string; hint: string; min: number; max: number; step?: number; def?: number }> = [
  { key: "maxTurns", label: "Turns per run", hint: "Agent turns before a run is stopped.", min: 1, max: 2000 },
  { key: "maxBudgetUsd", label: "Budget per run ($)", hint: "API-equivalent dollars before a run is stopped.", min: 0.1, max: 500, step: 0.1 },
  { key: "maxMinutes", label: "Minutes per run", hint: "Wall-clock time before a run is stopped.", min: 1, max: 720 },
  { key: "maxFixRounds", label: "Fix rounds", hint: "Rounds of fixing after failed checks or review before a person takes over.", min: 0, max: 10 },
  { key: "concurrency", label: "Runs at once", hint: "How many requests of this project may run together.", min: 1, max: 10 },
  { key: "verifyMinutes", label: "Test minutes", hint: "How long the test and build commands may take.", min: 1, max: 240 },
  { key: "maxInReview", label: "Waiting in review", hint: "New builds hold while this many changes wait for a person.", min: 1, max: 50 },
  { key: "observeMinutes", label: "Watch after deploy (min)", hint: "After a deploy, watch health_url this long; two failed checks block the item.", min: 0, max: 120, def: 2 },
];
const TOOL_MODES = [
  { value: "readonly", label: "Read only", hint: "Read and search the code; no edits." },
  { value: "edit", label: "Edit", hint: "Read and edit files; the shell is limited to the allow list and safe commands." },
  { value: "full", label: "Full", hint: "Any tool, any command, except what the deny list names. Only for trusted repositories." },
] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

type EnvRow = { key: string; value: string; existing: boolean; remove: boolean };
type Form = {
  slug: string; name: string; description: string; where: "repo" | "local"; repo_url: string; local_path: string; default_branch: string;
  runner: string; model: string; effort: string; setup_command: string; test_command: string; build_command: string; deploy_command: string; health_url: string;
  delivery: "pr" | "local"; gates: Gates; limits: Record<keyof Limits, string>; mode: "readonly" | "edit" | "full"; allow: string; deny: string;
  /** One folder per line. */
  dirs: string;
  /** The mcpServers object as JSON text; empty for none. */
  mcp: string;
  env: EnvRow[]; instructions: string; paused: boolean;
};

export const toSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);

function fromProject(p: Project): Form {
  return {
    slug: p.slug, name: p.name, description: p.description ?? "", where: p.local_path ? "local" : "repo", repo_url: p.repo_url ?? "", local_path: p.local_path ?? "", default_branch: p.default_branch,
    runner: p.runner ?? "", model: p.model ?? "", effort: p.effort ?? "", setup_command: p.setup_command ?? "", test_command: p.test_command ?? "", build_command: p.build_command ?? "", deploy_command: p.deploy_command ?? "", health_url: p.health_url ?? "",
    delivery: p.delivery, gates: { ...p.gates }, limits: Object.fromEntries(LIMITS.map((l) => [l.key, String(p.limits[l.key] ?? l.def ?? "")])) as Form["limits"], mode: p.tools.mode, allow: p.tools.allow.join("\n"), deny: p.tools.deny.join("\n"),
    dirs: (p.tools.dirs ?? []).join("\n"), mcp: mcpText(p.tools.mcp),
    env: p.env.map((k) => ({ key: k, value: "", existing: true, remove: false })), instructions: p.instructions ?? "", paused: p.paused,
  };
}
function fresh(d: ProjectDefaults): Form {
  return {
    slug: "", name: "", description: "", where: "local", repo_url: "", local_path: "", default_branch: "main", runner: "", model: "", effort: "",
    setup_command: "", test_command: "", build_command: "", deploy_command: "", health_url: "", delivery: "local", gates: { ...d.gates },
    limits: Object.fromEntries(LIMITS.map((l) => [l.key, String(d.limits[l.key] ?? l.def ?? "")])) as Form["limits"], mode: d.tools.mode, allow: d.tools.allow.join("\n"), deny: d.tools.deny.join("\n"), dirs: "", mcp: "",
    env: [], instructions: "", paused: false,
  };
}
const orNull = (s: string) => (s.trim() ? s.trim() : null);
const mcpText = (m: Record<string, McpServer> | undefined) => (m && Object.keys(m).length ? JSON.stringify(m, null, 2) : "");
/** The MCP box as an object, or why it is not one. Accepts the whole {"mcpServers": {…}} file as well as its inside. */
function parseMcp(text: string): { value: Record<string, McpServer> } | { error: string } {
  if (!text.trim()) return { value: {} };
  try {
    const v = JSON.parse(text) as unknown;
    const servers = v && typeof v === "object" && "mcpServers" in v ? (v as { mcpServers: unknown }).mcpServers : v;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { error: "MCP servers must be a JSON object of servers by name" };
    return { value: servers as Record<string, McpServer> };
  } catch (e) { return { error: `MCP servers: ${e instanceof Error ? e.message : "not valid JSON"}` }; }
}
// What a member may change on a project; everything else is an admin's (MEMBER_FIELDS in server/routes/projects.ts).
const MEMBER_FIELDS = ["name", "description", "instructions", "model", "effort", "paused"] as const;

function payload(f: Form, editing: boolean) {
  const mcp = parseMcp(f.mcp);
  const env: Record<string, string> = {};
  for (const r of f.env) {
    const k = r.key.trim();
    if (!k) continue;
    if (r.existing && r.remove) { if (editing) env[k] = ""; continue; }
    if (r.value !== "") env[k] = r.value;
  }
  return {
    slug: f.slug.trim(), name: f.name.trim(), description: orNull(f.description),
    repo_url: f.where === "repo" ? orNull(f.repo_url) : null, local_path: f.where === "local" ? orNull(f.local_path) : null, default_branch: f.default_branch.trim() || "main",
    runner: orNull(f.runner), model: orNull(f.model), effort: orNull(f.effort),
    setup_command: orNull(f.setup_command), test_command: orNull(f.test_command), build_command: orNull(f.build_command), deploy_command: orNull(f.deploy_command), health_url: orNull(f.health_url),
    // An empty box means "leave it as it is" (the default, for a new project), not 0.
    delivery: f.delivery, gates: f.gates, limits: Object.fromEntries(LIMITS.filter((l) => f.limits[l.key].trim() !== "").map((l) => [l.key, Number(f.limits[l.key])])),
    tools: { mode: f.mode, allow: splitLines(f.allow), deny: splitLines(f.deny), dirs: splitLines(f.dirs), mcp: "value" in mcp ? mcp.value : {} }, env, instructions: orNull(f.instructions), paused: f.paused,
  };
}

export default function ProjectEdit() {
  const { id } = useParams();
  const editing = Boolean(id);
  const me = useMe();
  const navigate = useNavigate();
  const { data: defaults } = useApi<ProjectDefaults>("/api/projects/defaults");
  const { data: project, error } = useApi<Project>(editing ? `/api/projects/${id}` : null);
  const [f, setF] = useState<Form | null>(null);
  const [slugTouched, setSlugTouched] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (!f && editing && project) setF(fromProject(project)); else if (!f && !editing && defaults) setF(fresh(defaults)); }, [f, editing, project, defaults]);

  if (!me.canEdit) return <Page title="Project"><Empty title="Members only" hint="Viewers can look at projects but not change them." /></Page>;
  if (!editing && !me.isAdmin) return <Page title="New project"><Empty title="Admins only" hint="Ask an admin to add a project." /></Page>;
  if (error) return <Page title="Edit project"><ErrorNote error={error} /></Page>;
  if (!f || !defaults) return <Page title={editing ? "Edit project" : "New project"}><Loading /></Page>;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const text = (k: keyof Form) => ({ value: String(f[k] ?? ""), onChange: (e: { target: { value: string } }) => set(k, e.target.value as never) });
  const slugOk = /^[a-z0-9][a-z0-9-]{0,62}$/.test(f.slug);
  const whereOk = f.where === "repo" ? Boolean(f.repo_url.trim()) : Boolean(f.local_path.trim());
  const mcpParsed = parseMcp(f.mcp);
  const mcpError = "error" in mcpParsed ? mcpParsed.error : null;
  const ok = Boolean(f.name.trim()) && slugOk && whereOk && !mcpError;
  // A member edits only the words, the model and the pause; the server refuses the rest.
  const locked = !me.isAdmin;

  const save = async () => {
    if (!ok || busy) return;
    setBusy(true); setErr("");
    try {
      const all = payload(f, editing);
      const body = locked ? Object.fromEntries(MEMBER_FIELDS.map((k) => [k, all[k]])) : all;
      const p = editing ? await patch<Project>(`/api/projects/${id}`, body) : await post<Project>("/api/projects", body);
      invalidate("/api/projects", "/api/board");
      toast(editing ? "Project saved" : "Project added");
      navigate(`/projects/${p.id}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Page title={editing ? `Edit ${project?.name ?? "project"}` : "New project"} subtitle={editing ? undefined : "Point the factory at a repository and say how far it may go on its own."}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {locked && <p className="quiet">You can change the name, description, instructions, model, effort and pause; the rest is for admins.</p>}
        <FormCard title="The project">
          <div className="grid2">
            <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: slugTouched ? f.slug : toSlug(e.target.value) })} maxLength={100} placeholder="Billing service" /></Field>
            <Field label="Slug" required hint={slugOk || !f.slug ? "Lowercase letters, digits and dashes; used in branch names and chat commands." : "Only lowercase letters, digits and dashes, starting with a letter or digit."}>
              <Input value={f.slug} onChange={(e) => { setSlugTouched(true); set("slug", e.target.value); }} maxLength={63} className="mono-input" placeholder="billing" aria-invalid={Boolean(f.slug) && !slugOk} disabled={locked} />
            </Field>
          </div>
          <Field label="Description"><Textarea rows={2} {...text("description")} maxLength={2000} placeholder="What this repository is, for the people reading the board" /></Field>
        </FormCard>

        <FormCard title="Where the code is" disabled={locked}>
          <Field label="Source" group>
            <Segmented label="Where the code is" value={f.where} onChange={(v) => setF({ ...f, where: v, delivery: v === "local" ? f.delivery : "pr" })}
              options={[{ value: "local", label: "A folder on this machine" }, { value: "repo", label: "A repository URL" }]} />
          </Field>
          {f.where === "repo"
            ? <Field label="Repository URL" required hint="The factory clones it into its data folder. It needs push access to open pull requests."><Input {...text("repo_url")} className="mono-input" placeholder="git@github.com:acme/billing.git" /></Field>
            : <Field label="Local path" required hint="An existing git checkout. The factory works in separate worktrees; your checkout is left alone."><Input {...text("local_path")} className="mono-input" placeholder="~/code/billing" /></Field>}
          <div className="grid2">
            <Field label="Default branch"><Input {...text("default_branch")} className="mono-input" /></Field>
            <Field group label="Delivery" hint={f.delivery === "pr" ? "Pushes a branch and opens a pull request." : "Merges into the default branch on this machine; nothing is pushed."}>
              <Segmented label="Delivery" value={f.delivery} onChange={(v) => set("delivery", v)} options={[{ value: "pr", label: "Pull request" }, { value: "local", label: "Local merge" }]} />
            </Field>
          </div>
        </FormCard>

        <FormCard title="The agent">
          <div className="grid3">
            <Field label="Runner" hint={`Default: ${defaults.defaultRunner}`}>
              <Select {...text("runner")} disabled={locked}>
                <option value="">Default</option>
                {defaults.runners.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </Select>
            </Field>
            <Field label="Model" hint={`Default: ${defaults.defaultModel}`}><Input {...text("model")} className="mono-input" placeholder={defaults.defaultModel} /></Field>
            <Field label="Effort">
              <Select {...text("effort")}>
                <option value="">Default</option>
                {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Instructions" hint="House rules for this repository, added to every prompt: conventions, what not to touch, how to run things.">
            <Textarea rows={6} {...text("instructions")} maxLength={20000} />
          </Field>
        </FormCard>

        <FormCard title="Commands" disabled={locked} hint="Run in the worktree with the project's env. Leave empty to skip a step.">
          <div className="grid2">
            <Field label="Setup" hint="Once per worktree, before building."><Input {...text("setup_command")} className="mono-input" placeholder="npm ci" /></Field>
            <Field label="Test" hint="Must pass before review."><Input {...text("test_command")} className="mono-input" placeholder="npm test" /></Field>
            <Field label="Build" hint="Must pass before review."><Input {...text("build_command")} className="mono-input" placeholder="npm run build" /></Field>
            <Field label="Deploy" hint="After merging, when the deploy gate opens."><Input {...text("deploy_command")} className="mono-input" placeholder="./ops/deploy.sh" /></Field>
          </div>
          <Field label="Health URL" hint="Watched after a deploy for the minutes set under Limits; two failed checks block the request."><Input {...text("health_url")} className="mono-input" placeholder="http://127.0.0.1:4100/api/healthz" /></Field>
        </FormCard>

        <FormCard title="Gates" disabled={locked} hint="Where a person must say yes before the factory goes on.">
          <div className="gate-grid">
            {(Object.keys(GATE_OPTIONS) as Array<keyof Gates>).map((g) => (
              <Field key={g} label={g === "review" ? "AI review" : `${g[0].toUpperCase()}${g.slice(1)}`} hint={GATE_HELP[g][f.gates[g]]}>
                <Select value={f.gates[g]} onChange={(e) => set("gates", { ...f.gates, [g]: e.target.value } as Gates)}>
                  {GATE_OPTIONS[g].map((o) => <option key={o} value={o}>{OPTION_LABEL[o]}</option>)}
                </Select>
              </Field>
            ))}
          </div>
        </FormCard>

        <FormCard title="Limits" disabled={locked}>
          <div className="grid3">
            {LIMITS.map((l) => (
              <Field key={l.key} label={l.label} hint={l.hint}>
                <Input type="number" inputMode="decimal" min={l.min} max={l.max} step={l.step ?? 1} value={f.limits[l.key]} onChange={(e) => set("limits", { ...f.limits, [l.key]: e.target.value })} className="num" />
              </Field>
            ))}
          </div>
        </FormCard>

        <FormCard title="Tools" disabled={locked}>
          <Field group label="What the agent may use" hint={TOOL_MODES.find((m) => m.value === f.mode)?.hint}>
            <Segmented label="Tool mode" value={f.mode} onChange={(v) => set("mode", v)} options={TOOL_MODES.map((m) => ({ value: m.value, label: m.label }))} />
          </Field>
          <div className="grid2">
            <Field label="Also allow" hint="One per line, in the runner's syntax, e.g. Bash(npm run lint:*)"><Textarea rows={4} {...text("allow")} className="mono-input" /></Field>
            <Field label="Always deny" hint="One per line; wins over everything else."><Textarea rows={4} {...text("deny")} className="mono-input" /></Field>
          </div>
          <p className="quiet">Allowing a command lifts the factory's own block on it, e.g. Bash(kubectl get:*) or Bash(curl:*). Pushing, git config, sudo and shell wrappers stay blocked.</p>
          <Field label="Folders the agent may read" hint="One full path per line. Outside the worktree, read only: another repository, a shared library, generated docs.">
            <Textarea rows={2} {...text("dirs")} className="mono-input" placeholder="~/Self/shared-lib" />
          </Field>
          <Field label="MCP servers" hint={<>JSON, the same shape as an .mcp.json file. Put keys under Environment below and write them here as <span className="mono">{"${NAME}"}</span>; other values are hidden once saved. Claude runner only.</>}>
            <Textarea rows={6} {...text("mcp")} className="mono-input" aria-invalid={Boolean(mcpError)} spellCheck={false}
              placeholder={'{\n  "grafana": {\n    "command": "mcp-grafana",\n    "env": { "GRAFANA_URL": "https://grafana.example.com", "GRAFANA_API_KEY": "${GRAFANA_API_KEY}" }\n  }\n}'} />
          </Field>
          {mcpError && <p className="error" role="alert">{mcpError}</p>}
        </FormCard>

        <FormCard title="Environment" disabled={locked} hint="Variables for the commands and the agent. Saved values are never shown again; type a new value to replace one.">
          <EnvRows rows={f.env} onChange={(env) => set("env", env)} />
        </FormCard>

        <FormCard title="Paused">
          <label className="inline"><Toggle checked={f.paused} onChange={(v) => set("paused", v)} label="Pause this project" /><span>{f.paused ? "Paused: new requests wait until it is resumed." : "Running: requests are planned and built as they arrive."}</span></label>
        </FormCard>

        {err && <p className="error" role="alert">{err}</p>}
        <div className="form-actions sticky">
          <Link to={editing ? `/projects/${id}` : "/projects"} className="btn secondary">Cancel</Link>
          <Button type="submit" disabled={!ok || busy}>{busy ? "Saving…" : editing ? "Save project" : "Add project"}</Button>
        </div>
      </form>
    </Page>
  );
}

/** `disabled` locks every control inside at once, the way a fieldset does. */
function FormCard({ title, hint, disabled, children }: { title: string; hint?: string; disabled?: boolean; children: ReactNode }) {
  return (
    <fieldset className="form-card" disabled={disabled}>
      <legend className="form-card-title">{title}</legend>
      {hint && <p className="form-card-hint">{hint}</p>}
      <div className="form-card-body">{children}</div>
    </fieldset>
  );
}

function EnvRows({ rows, onChange }: { rows: EnvRow[]; onChange: (r: EnvRow[]) => void }) {
  const up = (i: number, patchRow: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patchRow } : r)));
  return (
    <div className="env">
      {rows.map((r, i) => (
        <div key={i} className={`env-row ${r.remove ? "removed" : ""}`}>
          {r.existing ? <span className="mono env-key">{r.key}</span> : <Input aria-label="Name" value={r.key} onChange={(e) => up(i, { key: e.target.value.replace(/\s/g, "") })} placeholder="NAME" className="mono-input" />}
          <span aria-hidden="true">=</span>
          <Input aria-label={`Value of ${r.key || "the variable"}`} type={r.existing ? "password" : "text"} value={r.value} disabled={r.remove} onChange={(e) => up(i, { value: e.target.value })} placeholder={r.existing ? "saved, type to replace" : "value"} className="mono-input" autoComplete="off" />
          {r.existing
            ? <Button size="sm" variant="ghost" onClick={() => up(i, { remove: !r.remove })}>{r.remove ? "Keep" : "Remove"}</Button>
            : <Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove ${r.key || "row"}`}>Remove</Button>}
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => onChange([...rows, { key: "", value: "", existing: false, remove: false }])}>Add variable</Button>
    </div>
  );
}
