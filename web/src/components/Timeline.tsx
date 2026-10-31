// The item's story, oldest first: status changes as milestones, each agent run as a group
// of what it said and which tools it used, and around them the checks, commits, posts,
// approvals and comments.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { refreshItemSoon, useItemStream } from "../lib/live";
import { useNow } from "../lib/clock";
import { fmtDate, fmtMs, fmtTime, money, plural, short } from "../lib/format";
import { familyOf, statusLabel } from "../lib/status";
import type { Ev, Run } from "../lib/types";
import { Icon } from "./icons";
import { Lamp } from "./status";
import { Button, Linkify, Loading, Spinner, Toggle } from "./ui";

type D = Record<string, unknown>;
const dataOf = (e: Ev): D => (e.data && typeof e.data === "object" ? (e.data as D) : {});
const PAGE = 2000;
/** Events that change the item's header, status or decision box, not only its timeline. */
const ITEM_REFRESH = new Set(["status", "approval", "run", "git", "system"]);
const ascending = (list: Ev[]) => { for (let i = 1; i < list.length; i++) if (list[i].id <= list[i - 1].id) return false; return true; };

/** Loads the whole history, then follows the item's own stream; on every reconnect it fetches what it missed. */
export function useItemEvents(itemId: number) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = useRef(0);
  const merge = useCallback((list: Ev[]) => {
    if (!list.length) return;
    setEvents((prev) => {
      const tail = prev.length ? prev[prev.length - 1].id : 0;
      // The usual case, a live event or a page that starts after what we have: append, no sort.
      if (list[0].id > tail && ascending(list)) {
        last.current = list[list.length - 1].id;
        return prev.concat(list);
      }
      const seen = new Set(prev.map((e) => e.id));
      const add = list.filter((e) => !seen.has(e.id));
      if (!add.length) return prev;
      const next = [...prev, ...add].sort((a, b) => a.id - b.id);
      last.current = next[next.length - 1].id;
      return next;
    });
  }, []);
  const catchUp = useCallback(async (after: number) => {
    for (let page = 0; page < 20; page++) {
      const list = await api<Ev[]>(`/api/items/${itemId}/events?after=${after}&limit=${PAGE}`);
      merge(list);
      if (list.length < PAGE) break;
      after = list[list.length - 1].id;
    }
  }, [itemId, merge]);
  useEffect(() => {
    setEvents([]); setLoaded(false); last.current = 0;
    catchUp(0).then(() => setLoaded(true), (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [catchUp]);
  useItemStream(itemId, (e) => {
    merge([e]);
    if (ITEM_REFRESH.has(e.type)) refreshItemSoon(itemId, e.type === "status" || e.type === "git");
  }, (reconnect) => {
    if (last.current) catchUp(last.current).catch(() => {});
    if (reconnect) refreshItemSoon(itemId, true); // the header and the diff may have moved while the stream was down
  });
  return { events, loaded, error };
}

type ToolPair = { tool: Ev; result?: Ev };
type RunRow = { kind: "text"; ev: Ev } | { kind: "tool"; pair: ToolPair } | { kind: "ev"; ev: Ev };
/** `n` counts the events folded into the block, so a memoised group can tell it grew (a result paired with its call adds no row). */
type RunBlock = { kind: "run"; runId: number; start?: Ev; end?: Ev; rows: RunRow[]; tools: number; texts: number; lastTool: ToolPair | null; n: number };
type Block = { kind: "ev"; ev: Ev } | RunBlock;

function build(events: Ev[], debug: boolean): Block[] {
  const blocks: Block[] = [];
  const groups = new Map<number, RunBlock>();
  const byToolId = new Map<string, ToolPair>();
  for (const e of events) {
    const d = dataOf(e);
    if (e.run_id == null) {
      if (e.level === "debug" && !debug) continue;
      blocks.push({ kind: "ev", ev: e });
      continue;
    }
    let g = groups.get(e.run_id);
    if (!g) { g = { kind: "run", runId: e.run_id, rows: [], tools: 0, texts: 0, lastTool: null, n: 0 }; groups.set(e.run_id, g); blocks.push(g); }
    g.n++;
    if (e.type === "run") { if (d.status === "running" && !g.start) g.start = e; else g.end = e; continue; }
    if (e.type === "tool") {
      const pair: ToolPair = { tool: e };
      g.rows.push({ kind: "tool", pair }); g.tools++; g.lastTool = pair;
      if (typeof d.id === "string") byToolId.set(d.id, pair);
      continue;
    }
    if (e.type === "tool_result") {
      const pair = (typeof d.id === "string" && byToolId.get(d.id)) || g.lastTool;
      if (pair && !pair.result) { pair.result = e; continue; }
      if (!debug) continue;
    }
    if (e.type === "text") { g.rows.push({ kind: "text", ev: e }); g.texts++; continue; }
    if (e.level === "debug" && !debug) continue;
    g.rows.push({ kind: "ev", ev: e });
  }
  return blocks;
}

export function Timeline({ itemId, runs, live, composer }: { itemId: number; runs: Run[]; live: boolean; composer?: ReactNode }) {
  const { events, loaded, error } = useItemEvents(itemId);
  const [debug, setDebug] = useState(false);
  const [follow, setFollow] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => build(events, debug), [events, debug]);
  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);
  const lastRunId = useMemo(() => { for (let i = blocks.length - 1; i >= 0; i--) { const b = blocks[i]; if (b.kind === "run") return b.runId; } return null; }, [blocks]);

  useEffect(() => { if (follow) end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [events.length, follow]);
  useEffect(() => {
    if (!follow) return;
    let lastY = window.scrollY;
    const onScroll = () => { const y = window.scrollY; if (y < lastY - 40) setFollow(false); lastY = y; };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [follow]);

  if (error) return <p className="error">{error}</p>;
  if (!loaded) return <Loading label="Loading the timeline" />;
  return (
    <div className="timeline">
      <div className="tl-tools">
        <label className="inline quiet"><Toggle checked={debug} onChange={setDebug} label="Show debug lines" />Debug lines</label>
        {live && <Button size="sm" variant={follow ? "primary" : "secondary"} aria-pressed={follow} onClick={() => setFollow(!follow)}>{follow ? "Following live" : "Follow live"}</Button>}
      </div>
      {!blocks.length && <p className="quiet">Nothing has happened yet.</p>}
      <ol className="tl">
        {blocks.map((b) => (b.kind === "run"
          ? <li key={`r${b.runId}`}><RunGroup block={b} run={runById.get(b.runId)} defaultOpen={b.runId === lastRunId && (live || !b.end)} debug={debug} /></li>
          : <li key={b.ev.id}><EventRow ev={b.ev} /></li>))}
      </ol>
      {composer}
      <div ref={end} />
    </div>
  );
}

/** The time of a line; on a phone the short form (14:02, or 31 Oct) shows instead. */
function When({ at }: { at: string }) {
  const sameDay = new Date(at).toDateString() === new Date().toDateString();
  return (
    <time className="tl-time num" dateTime={at} title={fmtDate(at)}>
      <span className="t-long">{sameDay ? fmtTime(at) : fmtDate(at)}</span>
      <span className="t-short">{sameDay ? fmtTime(at).slice(0, 5) : fmtDate(at, false)}</span>
    </time>
  );
}

const RUN_TITLE: Record<string, string> = { plan: "Planning run", build: "Build run", fix: "Fix run", review: "Review run", learn: "Learning run" };

/** `debug` is only compared: the same events build different rows with debug lines on. */
type RunGroupProps = { block: RunBlock; run?: Run; defaultOpen: boolean; debug: boolean };
const RUN_FIELDS = ["kind", "status", "model", "started_at", "finished_at", "cost_usd", "turns", "result", "error"] as const;
/** build() makes new blocks on every event; a run's group re-renders only when something it shows changed. */
const sameRunGroup = (a: RunGroupProps, b: RunGroupProps) =>
  a.defaultOpen === b.defaultOpen && a.debug === b.debug && a.block.runId === b.block.runId && a.block.n === b.block.n && a.block.start === b.block.start && a.block.end === b.block.end
  && (a.run === b.run || (!!a.run && !!b.run && RUN_FIELDS.every((k) => a.run![k] === b.run![k])));

const RunGroup = memo(function RunGroup({ block, run, defaultOpen }: RunGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  const sd = block.start ? dataOf(block.start) : {};
  const ed = block.end ? dataOf(block.end) : {};
  const kind = String(sd.kind ?? ed.kind ?? run?.kind ?? "agent");
  const status = String(ed.status ?? (run && run.status !== "running" ? run.status : "running"));
  const running = status === "running";
  const model = String(sd.model ?? run?.model ?? "") || null;
  const startedAt = block.start?.at ?? run?.started_at ?? null;
  const duration = typeof ed.durationMs === "number" ? ed.durationMs
    : run?.started_at && run.finished_at ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
    : null;
  const cost = typeof ed.costUsd === "number" ? ed.costUsd : run?.cost_usd ?? null;
  const turns = typeof ed.turns === "number" ? ed.turns : run?.turns ?? null;
  const fam = running ? "work" : status === "succeeded" ? "done" : status === "cancelled" ? "idle" : "bad";
  const bodyId = `run-${block.runId}`;
  return (
    <div className={`tl-run ${open ? "open" : ""}`}>
      <button type="button" className="tl-run-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        {running ? <Spinner /> : <Lamp family={fam} />}
        <span className="tl-run-title">{RUN_TITLE[kind] ?? `${kind} run`}</span>
        <span className="tl-run-meta">
          {model && <span>{model}</span>}
          <span>{running ? "running" : status}</span>
          {duration != null ? <span className="num">{fmtMs(duration)}</span> : running && startedAt ? <Elapsed since={startedAt} /> : null}
          {cost != null && <span className="num">{money(cost)}</span>}
          {turns != null && <span className="num">{plural(turns, "turn")}</span>}
          <span className="num">{plural(block.tools, "tool call")}</span>
        </span>
        <span className="grow" />
        {startedAt && <When at={startedAt} />}
        <span className="chev" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="tl-run-body" id={bodyId}>
          {block.rows.map((r) => (r.kind === "tool" ? <ToolRow key={r.pair.tool.id} pair={r.pair} />
            : r.kind === "text" ? <TextRow key={r.ev.id} ev={r.ev} />
            : <EventRow key={r.ev.id} ev={r.ev} inRun />))}
          {block.end && <EventRow ev={block.end} inRun />}
          {!running && run?.result && <div className="tl-final"><div className="tl-final-label">Final message</div><Linkify text={run.result} /></div>}
          {!running && run?.error && <p className="error">{run.error}</p>}
        </div>
      )}
    </div>
  );
}, sameRunGroup);

/** A running run's age, the only part of the group that moves with the clock. */
function Elapsed({ since }: { since: string }) {
  const now = useNow();
  return <span className="num">{fmtMs(now - new Date(since).getTime())}</span>;
}

function pretty(s: unknown): string {
  if (typeof s !== "string") return JSON.stringify(s, null, 2);
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

/** Pairs are rebuilt on every event; a row changes only when its call or its result does. */
const ToolRow = memo(function ToolRow({ pair }: { pair: ToolPair }) {
  const [open, setOpen] = useState(false);
  const d = dataOf(pair.tool);
  const name = String(d.name ?? (pair.tool.message ?? "").split(":")[0]);
  const msg = pair.tool.message ?? "";
  const summary = msg.startsWith(`${name}:`) ? msg.slice(name.length + 1).trim() : msg;
  const isError = Boolean(pair.result && dataOf(pair.result).isError);
  return (
    <div className={`tl-tool ${isError ? "err" : ""}`}>
      <button type="button" className="tl-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="tool" size={14} />
        <span className="tl-tool-name">{name}</span>
        <span className="tl-tool-sum">{short(summary, 200)}</span>
        {isError && <span className="tl-flag">error</span>}
        {!pair.result && <span className="tl-flag quiet">no result yet</span>}
      </button>
      {open && (
        <div className="tl-tool-body">
          <div className="tl-io-label">Input</div>
          <pre className="code">{pretty(d.input ?? "{}")}</pre>
          {pair.result && <><div className="tl-io-label">Result{isError ? " (error)" : ""}</div><pre className="code">{pair.result.message || "(empty)"}</pre></>}
        </div>
      )}
    </div>
  );
}, (a, b) => a.pair.tool === b.pair.tool && a.pair.result === b.pair.result);

const TextRow = memo(function TextRow({ ev }: { ev: Ev }) {
  return <div className="tl-text"><Linkify text={ev.message ?? ""} /></div>;
});

function Detail({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return <details className="tl-detail"><summary>{summary}</summary>{children}</details>;
}

// Events never change once written, so the same event object renders the same row.
const EventRow = memo(function EventRow({ ev, inRun }: { ev: Ev; inRun?: boolean }) {
  const d = dataOf(ev);
  if (ev.type === "status" && !inRun) {
    const st = String(d.status ?? "");
    const fam = familyOf(st);
    const msg = ev.message && ev.message !== st ? ev.message : "";
    return (
      <div className={`tl-milestone f-${fam}`}>
        <span className="lamp" aria-hidden="true" />
        <strong>{statusLabel(st)}</strong>
        {msg && <span className="tl-msg">{msg}</span>}
        <span className="grow" />
        {ev.actor && ev.actor !== "factory" && <span className="tl-actor">{ev.actor}</span>}
        <When at={ev.at} />
      </div>
    );
  }
  const tone = ev.level === "error" || ev.type === "error" ? "bad" : ev.level === "warn" ? "warn" : ev.level === "debug" ? "debug" : "";
  let body: ReactNode = <span className="tl-msg">{ev.message}</span>;
  let extra: ReactNode = null;
  if (ev.type === "feedback") {
    body = <><span className="tl-msg"><strong>{ev.actor ?? "someone"}</strong> {d.kind === "changes_requested" ? "requested changes" : d.kind === "approved" ? "approved" : d.kind === "answer" ? "answered" : "commented"}{d.source && d.source !== "ui" ? ` via ${String(d.source)}` : ""}</span><blockquote className="tl-quote"><Linkify text={ev.message ?? ""} /></blockquote></>;
  } else if (ev.type === "note" && d.review && typeof d.review === "object") {
    const rv = d.review as { verdict?: string; summary?: string; findings?: Array<{ severity: string; file: string; line?: number; message: string }> };
    extra = rv.findings?.length ? (
      <Detail summary={`${plural(rv.findings.length, "finding")}`}>
        <ul className="findings">{rv.findings.map((f, i) => <li key={i}><span className={`sev ${f.severity}`}>{f.severity}</span> <span className="mono">{f.file}{f.line ? `:${f.line}` : ""}</span> {f.message}</li>)}</ul>
      </Detail>
    ) : null;
  } else if (ev.type === "note" && d.plan) {
    body = <span className="tl-msg"><strong>Plan ready.</strong> {short(ev.message ?? "", 400)}</span>;
  } else if (ev.type === "verify" && typeof d.output === "string" && d.output) {
    extra = <Detail summary="Output"><pre className="code">{d.output}</pre></Detail>;
  } else if (ev.type === "git") {
    if (typeof d.url === "string") body = <span className="tl-msg">Pull request opened: <a href={d.url} target="_blank" rel="noreferrer noopener">{d.url}</a></span>;
    if (Array.isArray(d.files) && d.files.length) extra = <Detail summary={plural(d.files.length, "file")}><ul className="files">{(d.files as string[]).map((f) => <li key={f} className="mono">{f}</li>)}</ul></Detail>;
  } else if (ev.type === "post") {
    const target = d.target ? String(d.target) : null;
    body = <span className="tl-msg">{target || d.telegram ? <strong>Told {[target, d.telegram ? "Telegram" : null].filter(Boolean).join(" and ")}: </strong> : <strong>Status: </strong>}{ev.message}</span>;
  } else if (ev.type === "approval") {
    body = <span className="tl-msg">{ev.message}{d.via ? ` (via ${String(d.via)})` : ""}</span>;
  } else if (ev.type === "tool_result") {
    body = <pre className="code sm">{short(ev.message ?? "", 600)}</pre>;
  } else if (ev.type === "status") {
    body = <span className="tl-msg">{statusLabel(String(d.status ?? ""))}{ev.message ? `: ${ev.message}` : ""}</span>;
  }
  return (
    <div className={`tl-row t-${ev.type} ${tone}`}>
      <span className="tl-ico"><Icon name={(ev.type === "log" || ev.type === "git") && tone === "warn" ? "error" : ev.type} size={14} /></span>
      <div className="grow tl-content">{body}{extra}</div>
      {ev.actor && !["factory", "claude", "fake"].includes(ev.actor) && ev.type !== "feedback" && <span className="tl-actor">{ev.actor}</span>}
      <When at={ev.at} />
    </div>
  );
});
