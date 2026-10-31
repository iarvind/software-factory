#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// `factory`: the software factory from a terminal. Talks to the API at FACTORY_URL
// (http://127.0.0.1:8282 by default) with FACTORY_TOKEN, an `ft_…` API token from Settings.
// No dependencies: Node runs this file as it is.
import fs from "node:fs";
import { ApiError, client, sse } from "./client.ts";

type Item = { id: number; project_id: number | null; title: string; body: string; status: string; gate: string | null; priority: number; labels: string[]; kind: string | null; size: string | null; risk: string | null; branch: string | null; worktree: string | null; pr_url: string | null; error: string | null; cost_usd: number; turns: number; fix_rounds: number; verify_rounds: number; requester_name: string | null; created_at: string; updated_at: string; plan: { summary?: string; steps?: string[]; questions?: string[]; estimate_minutes?: number } | null };
type Project = { id: number; slug: string; name: string; delivery: string; runner: string | null; paused: boolean; open: number; done: number; default_branch: string };
type Run = { id: number; kind: string; runner: string; model: string | null; status: string; cost_usd: number | null; turns: number | null; error: string | null; started_at: string | null; finished_at: string | null };
type Approval = { id: number; item_id: number; kind: string; status: string; summary: string | null; requested_at: string; title?: string };
type Ev = { id: number; type: string; level: string; message: string | null; data: { status?: string } | null; actor: string | null; at: string };

const USAGE = `factory — the software factory from a terminal

Usage:
  factory status                                   what is running, waiting and done today
  factory ls [--open] [--project slug] [--status a,b] [--limit n]
  factory new <project> <title> [--body "…" | --body -] [--priority 1-5] [--label x]…
  factory show <id>                                the item, its plan, runs and latest events (--json: all events)
  factory watch <id>                               follow an item live until it is done, failed, cancelled or blocked
  factory approve <id> [note]                      open the gate the item waits at
  factory reject <id> [note]
  factory review <id> approve [comment]            a reviewer's verdict on the built change
  factory review <id> changes <comment>            ask for a fix round; say what to change
  factory comment <id> <text>                      an answer, or feedback for the next round
  factory cancel <id>
  factory retry <id>
  factory projects
  factory approvals                                everything waiting for a decision

Options: --json prints the API's answer as it is. -h, --help shows this. A command refuses flags it does not take.
Exit codes: 0 ok; 4 a usage, API or network error. watch exits by how the item ended:
  0 done, 1 failed, 2 cancelled, 3 blocked (4 if the CLI or the network gave up first).
Environment: FACTORY_URL (default http://127.0.0.1:8282), FACTORY_TOKEN (an ft_… token from Settings).`;

/** Wrong arguments: the message, then a pointer to --help; exits 4 like any other error. */
export class UsageError extends Error {}
/** For anything that is not an item's outcome: bad arguments, the API refusing, the network. */
export const EXIT_ERROR = 4;

const BOOLEAN = new Set(["open", "json", "help"]);
const REPEAT = new Set(["label"]);
/** The flags each command takes; anything else is a mistake worth stopping for. */
const FLAGS: Record<string, string[]> = {
  status: [], ls: ["open", "project", "status", "limit"], new: ["body", "priority", "label"], show: [], watch: [],
  approve: [], reject: [], review: [], comment: [], cancel: [], retry: [], projects: [], approvals: [],
};
export function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | boolean | string[]> } {
  const pos: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { flags.help = true; continue; }
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--") || a === "-") { pos.push(a); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq > 0 ? eq : undefined);
    let value: string | boolean = eq > 0 ? a.slice(eq + 1) : true;
    if (eq > 0 && BOOLEAN.has(name)) throw new UsageError(`--${name} takes no value`);
    if (value === true && !BOOLEAN.has(name)) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      value = argv[++i];
    }
    if (REPEAT.has(name)) flags[name] = [...((flags[name] as string[] | undefined) ?? []), String(value)];
    else flags[name] = value;
  }
  return { pos, flags };
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2"), bold = paint("1"), red = paint("31"), green = paint("32"), yellow = paint("33"), cyan = paint("36");
const statusColor = (s: string) => (s === "done" ? green : s === "failed" || s === "blocked" ? red : ["awaiting_approval", "needs_info", "review"].includes(s) ? yellow : ["cancelled", "inbox"].includes(s) ? dim : cyan)(s);

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
/** A plain table: columns padded to their widest cell, the last column cut to the terminal. */
export function table(head: string[], rows: Array<Array<string | number | null | undefined>>, width = process.stdout.columns || 120): string {
  const cells = rows.map((r) => r.map((c) => (c == null ? "" : String(c))));
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((r) => visible(r[i] ?? ""))));
  const lead = w.slice(0, -1).reduce((a, b) => a + b + 2, 0);
  const lastMax = Math.max(10, width - lead);
  const line = (r: string[], style = (s: string) => s) => r.map((c, i) => {
    if (i === r.length - 1) return visible(c) > lastMax ? `${c.slice(0, lastMax - 1).trimEnd()}…` : c;
    return c + " ".repeat(w[i] - visible(c));
  }).map(style).join("  ").trimEnd();
  return [line(head, dim), ...cells.map((r) => line(r))].join("\n");
}

const statusOf = (it: { status: string; gate: string | null }) => (it.gate && it.status === "awaiting_approval" ? `${statusColor(it.status)} ${dim(`(${it.gate})`)}` : statusColor(it.status));
const fmtEvent = (e: Ev) => {
  const t = new Date(e.at).toLocaleTimeString([], { hour12: false });
  const msg = (e.message ?? "").replace(/\s+/g, " ").slice(0, 300);
  const style = e.level === "error" ? red : e.level === "warn" ? yellow : e.type === "status" ? bold : (s: string) => s;
  return `${dim(t)} ${dim(e.type.padEnd(11))} ${style(msg)}${e.actor && e.actor !== "factory" ? dim(` — ${e.actor}`) : ""}`;
};
/** Where `watch` stops, and the exit code that says how. */
const ENDS = new Map([["done", 0], ["failed", 1], ["cancelled", 2], ["blocked", 3]]);

function id(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`expected an item id, got "${v ?? ""}"`);
  return n;
}
/** A whole number in [min, max] from a flag, or a usage error that names the flag. */
function intFlag(name: string, v: string, min: number, max: number, what: string): number {
  const n = Number(v);
  if (!/^\d+$/.test(v.trim()) || !Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} is ${what}, got "${v}"`);
  return n;
}

/** The item's whole history, oldest first: the endpoint answers in pages of PAGE from `after`. */
const PAGE = 2000;
export async function allEvents(api: Pick<ReturnType<typeof client>, "get">, n: number, after = 0): Promise<Ev[]> {
  const all: Ev[] = [];
  for (;;) {
    const page = await api.get<Ev[]>(`/api/items/${n}/events?after=${after}&limit=${PAGE}`);
    all.push(...page);
    const next = page.at(-1)?.id ?? after;
    if (page.length < PAGE || next <= after) return all; // a short page is the end (and a page that does not move on would loop)
    after = next;
  }
}

export async function main(argv: string[]): Promise<number> {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || flags.help || cmd === "help") { console.log(USAGE); return cmd || flags.help ? 0 : EXIT_ERROR; }
  if (!Object.hasOwn(FLAGS, cmd)) { console.error(`factory: unknown command "${cmd}"\n\n${USAGE}`); return EXIT_ERROR; }
  for (const f of Object.keys(flags)) {
    if (f !== "json" && f !== "help" && !FLAGS[cmd].includes(f)) throw new UsageError(`factory ${cmd} does not take --${f}`);
  }
  const api = client();
  const out = (data: unknown, pretty: () => string) => console.log(flags.json ? JSON.stringify(data, null, 2) : pretty());
  const projects = () => api.get<Project[]>("/api/projects");
  const slugOf = (ps: Project[], pid: number | null) => ps.find((p) => p.id === pid)?.slug ?? "";

  switch (cmd) {
    case "status": {
      const s = await api.get<{ paused: boolean; held: string | null; active: Array<{ itemId: number; kind: string; startedAt: string }>; counts: Array<{ status: string; n: number }>; today: { done: number; created: number } | null; waiting: Array<{ id: number; title: string; status: string; gate: string | null; updated_at: string }> }>("/api/status");
      out(s, () => [
        s.paused ? red("The factory is paused: nothing new starts.") : green("The factory is running."),
        s.held ? yellow(`Holding new runs: ${s.held}`) : "",
        `Today: ${s.today?.created ?? 0} arrived, ${s.today?.done ?? 0} done. Open: ${s.counts.map((c) => `${c.n} ${c.status}`).join(", ") || "nothing"}.`,
        s.active.length ? `\n${bold("Running")}\n${table(["item", "stage", "since"], s.active.map((a) => [`#${a.itemId}`, a.kind, ago(a.startedAt)]))}` : "\nNothing is running.",
        s.waiting.length ? `\n${bold("Waiting for people")}\n${table(["item", "status", "since", "title"], s.waiting.map((w) => [`#${w.id}`, statusOf(w), ago(w.updated_at), w.title]))}` : "",
      ].filter(Boolean).join("\n"));
      return 0;
    }
    case "ls": {
      const qs = new URLSearchParams();
      if (flags.open) qs.set("open", "1");
      if (typeof flags.status === "string") qs.set("status", flags.status);
      if (typeof flags.limit === "string") qs.set("limit", String(intFlag("limit", flags.limit, 1, 500, "a number from 1 to 500")));
      const ps = await projects();
      if (typeof flags.project === "string") {
        const p = ps.find((x) => x.slug === flags.project);
        if (!p) throw new Error(`no project "${flags.project}" (have: ${ps.map((x) => x.slug).join(", ") || "none"})`);
        qs.set("project", String(p.id));
      }
      const items = await api.get<Item[]>(`/api/items${qs.size ? `?${qs}` : ""}`);
      out(items, () => (items.length ? table(["id", "status", "project", "p", "updated", "title"], items.map((it) => [`#${it.id}`, statusOf(it), slugOf(ps, it.project_id), it.priority, ago(it.updated_at), it.title])) : "No items."));
      return 0;
    }
    case "new": {
      const [slug, ...words] = rest;
      const title = words.join(" ").trim();
      if (!slug || !title) throw new UsageError("usage: factory new <project> <title> [--body …|--body -] [--priority n] [--label x]");
      const priority = typeof flags.priority === "string" ? intFlag("priority", flags.priority, 1, 5, "1 (highest) to 5") : undefined;
      const p = (await projects()).find((x) => x.slug === slug);
      if (!p) throw new Error(`no project "${slug}"`);
      const body = flags.body === "-" ? fs.readFileSync(0, "utf8") : typeof flags.body === "string" ? flags.body : undefined;
      const it = await api.post<Item>("/api/items", { title, body, projectId: p.id, priority, labels: flags.label as string[] | undefined });
      out(it, () => `#${it.id} created in ${p.slug}: ${it.title}\n${dim(`${api.url}/items/${it.id}`)}`);
      return 0;
    }
    case "show": {
      const n = id(rest[0]);
      const d = await api.get<{ item: Item; runs: Run[]; approvals: Approval[]; project: { slug: string } | null; active: boolean; pending: Approval | null }>(`/api/items/${n}`);
      const evs = await allEvents(api, n);
      out({ ...d, events: evs }, () => {
        const it = d.item;
        const lines = [
          `${bold(`#${it.id} ${it.title}`)}`,
          `${statusOf(it)}${d.active ? cyan(" (running)") : ""} · ${d.project?.slug ?? "no project"} · priority ${it.priority}${it.kind ? ` · ${it.kind}/${it.size}/${it.risk} risk` : ""} · $${Number(it.cost_usd).toFixed(2)}, ${it.turns} turns`,
          it.branch ? dim(`branch ${it.branch}${it.pr_url ? ` · ${it.pr_url}` : ""}`) : "",
          it.error ? red(`error: ${it.error}`) : "",
          d.pending ? yellow(`waiting for approval: ${d.pending.kind} (factory approve ${it.id})`) : "",
          it.body ? `\n${it.body.trim().slice(0, 1500)}` : "",
        ];
        if (it.plan) {
          const steps = Array.isArray(it.plan.steps) ? it.plan.steps : [], questions = Array.isArray(it.plan.questions) ? it.plan.questions : [];
          lines.push(`\n${bold("Plan")}${it.plan.estimate_minutes ? dim(` (~${it.plan.estimate_minutes} min)`) : ""}`, it.plan.summary ?? "", ...steps.map((s, i) => `  ${i + 1}. ${s}`), ...(questions.length ? ["Questions:", ...questions.map((q) => `  ? ${q}`)] : []));
        }
        if (d.runs.length) lines.push(`\n${bold("Runs")}`, table(["run", "kind", "status", "runner", "turns", "cost", "when"], d.runs.map((r) => [r.id, r.kind, r.status === "failed" ? red(r.status) : r.status, `${r.runner}${r.model ? `/${r.model}` : ""}`, r.turns ?? "", r.cost_usd != null ? `$${Number(r.cost_usd).toFixed(2)}` : "", ago(r.started_at)])));
        if (evs.length) lines.push(`\n${bold(evs.length > 15 ? `Latest events (15 of ${evs.length})` : "Latest events")}`, ...evs.slice(-15).map(fmtEvent));
        return lines.filter((l) => l !== "").join("\n");
      });
      return 0;
    }
    case "watch": return watch(api, id(rest[0]), Boolean(flags.json));
    case "approve": case "reject": {
      const n = id(rest[0]);
      const it = await api.post<Item>(`/api/items/${n}/${cmd}`, { note: rest.slice(1).join(" ") || undefined });
      out(it, () => `#${it.id} ${cmd === "approve" ? "approved" : "rejected"}; now ${statusOf(it)}`);
      return 0;
    }
    case "review": {
      const n = id(rest[0]);
      const v = rest[1];
      if (v !== "approve" && v !== "changes") throw new UsageError("usage: factory review <id> approve [comment] | changes <comment>");
      const comment = rest.slice(2).join(" ").trim();
      if (v === "changes" && !comment) throw new UsageError("factory review <id> changes needs a comment: say what to change");
      const it = await api.post<Item>(`/api/items/${n}/review`, { decision: v === "approve" ? "approved" : "changes_requested", body: comment || undefined });
      out(it, () => `#${it.id}: ${v === "approve" ? "approved" : "changes requested"}; now ${statusOf(it)}`);
      return 0;
    }
    case "comment": {
      const n = id(rest[0]);
      const text = rest.slice(1).join(" ").trim();
      if (!text) throw new UsageError("usage: factory comment <id> <text>");
      const r = await api.post(`/api/items/${n}/comment`, { body: text });
      out(r, () => `comment added to #${n}`);
      return 0;
    }
    case "cancel": case "retry": {
      const it = await api.post<Item>(`/api/items/${id(rest[0])}/${cmd}`);
      out(it, () => `#${it.id} ${cmd === "cancel" ? "cancelled" : "retried"}; now ${statusOf(it)}`);
      return 0;
    }
    case "projects": {
      const ps = await projects();
      out(ps, () => (ps.length ? table(["slug", "delivery", "runner", "open", "done", "name"], ps.map((p) => [p.paused ? `${p.slug} ${yellow("(paused)")}` : p.slug, p.delivery, p.runner ?? "default", p.open, p.done, p.name])) : "No projects yet."));
      return 0;
    }
    case "approvals": {
      const as = await api.get<Approval[]>("/api/approvals");
      out(as, () => (as.length ? table(["item", "gate", "asked", "title"], as.map((a) => [`#${a.item_id}`, a.kind, ago(a.requested_at), a.title ?? a.summary ?? ""])) : "Nothing is waiting for a decision."));
      return 0;
    }
    default:
      console.error(`factory: unknown command "${cmd}"\n\n${USAGE}`);
      return EXIT_ERROR;
  }
}

/** Prints what has happened so far, then follows the live stream until the item is done, failed, cancelled or
 *  blocked (exit 0, 1, 2, 3); reconnects (and catches up) when the stream drops. */
async function watch(api: ReturnType<typeof client>, n: number, json: boolean): Promise<number> {
  const print = (e: Ev) => console.log(json ? JSON.stringify(e) : fmtEvent(e));
  let last = 0;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    try {
      const res = await api.stream(`/api/events/stream?item=${n}`, ctrl.signal);
      // Catch up after the stream is open, so nothing falls between the two.
      for (const e of await allEvents(api, n, last)) { if (e.id > last) { print(e); last = e.id; } }
      const { item } = await api.get<{ item: Item }>(`/api/items/${n}`);
      if (ENDS.has(item.status)) return ENDS.get(item.status)!;
      attempt = 0;
      for await (const m of sse(res.body!)) {
        if (m.event !== "event") continue;
        const e = JSON.parse(m.data) as Ev;
        if (e.id <= last) continue;
        print(e);
        last = e.id;
        const st = e.type === "status" ? e.data?.status : undefined;
        if (st && ENDS.has(st)) return ENDS.get(st)!;
      }
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e;
      if (attempt >= 5) throw e;
      console.error(dim(`(stream lost: ${e instanceof Error ? e.message : String(e)}; reconnecting)`));
    } finally {
      ctrl.abort(); // after the loop has let go of the stream; aborting first would make that throw
    }
    await new Promise((r) => setTimeout(r, 1000 * Math.min(10, 2 ** attempt)));
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`factory: ${e instanceof Error ? e.message : String(e)}${e instanceof UsageError ? "\n(factory --help lists the commands and their flags)" : ""}`);
    process.exit(EXIT_ERROR);
  });
}
