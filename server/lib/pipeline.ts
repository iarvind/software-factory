// The factory floor. Work items move through plan → build → verify → review → merge → deploy
// → done; this file is what moves them. A tick every few seconds starts what is ready, within
// the concurrency limits; everything else is driven by what comes back: a run finishing, a
// person approving, a reviewer asking for changes, a requester answering a question.
import fs from "node:fs";
import path from "node:path";
import { q, one } from "../db.ts";
import { emit, log } from "./events.ts";
import { ACTIVE, ItemClosed, addCost, addFeedback, bumpRounds, claim, decideApproval, feedbackFor, getItem, lastRun, markHandled, mustItem, pendingApproval, requestApproval, saveBranch, savePlan, setStatus, unhandledFeedback, type Approval, type Feedback, type Item, type Run } from "./items.ts";
import { gateIsManual, getProject, listProjects, mustProject, notesFor, addNote, type Project } from "./projects.ts";
import { baseRef, branchName, commitLog, createWorktree, diff, githubRepo, hasRemote, isConflict, withRepoLock, mergeLocal, mergePr, openPr, push, reconcileWithBase, removeWorktree, repoDir, settle } from "./git.ts";
import { git, run, shell, tail } from "./exec.ts";
import { getRunner, type RunEvent, type RunResult, type RunSpec } from "./runners/index.ts";
import { DEFAULT_MODEL, SMALL_MODEL } from "./runners/claude.ts";
import { expandHome } from "./discover.ts";
import { refusalSummary, toolSummary } from "./tools.ts";
import { buildPrompt, fixPrompt, houseRules, notePrompt, planPrompt, prBody, reviewPrompt, NOTE_SCHEMA, PLAN_SCHEMA, REVIEW_SCHEMA, type Plan } from "./prompts.ts";
import { itemLink, postStatus } from "./conversations.ts";
import { settings } from "./settings.ts";
import { spentToday } from "./metrics.ts";

export type RunKind = "plan" | "build" | "fix" | "review" | "learn";
type Slot = { runId: number | null; kind: string; ctrl: AbortController; startedAt: number; projectId: number | null };

const active = new Map<number, Slot>();
const LOOP_LIMIT = 4;

/** What a project lets its working agents reach past the worktree: folders to read, MCP servers. */
const access = (p: Project): Pick<RunSpec, "readDirs" | "mcp"> => ({ readDirs: p.tools.dirs.map((d) => path.resolve(expandHome(d))), mcp: p.tools.mcp });

const pending: Array<{ itemId: number; projectId: number; fn: () => Promise<void> }> = [];
let ticking = false;
class Cancelled extends Error { constructor() { super("cancelled"); } }
/** An error that knows which stage to resume from. */
class StageError extends Error { stage: string; constructor(stage: string, message: string) { super(message); this.stage = stage; } }

export const activeRuns = () => [...active.entries()].map(([itemId, s]) => ({ itemId, runId: s.runId, kind: s.kind, projectId: s.projectId, startedAt: new Date(s.startedAt).toISOString() }));
export const isActive = (itemId: number) => active.has(itemId);

function reserve(itemId: number, projectId: number | null, kind: string): Slot {
  const s: Slot = { runId: null, kind, ctrl: new AbortController(), startedAt: Date.now(), projectId };
  active.set(itemId, s);
  return s;
}
const release = (itemId: number) => active.delete(itemId);
/** Between the steps of a stage: stop here when a person cancelled the job meanwhile (only agent runs and commands hear the abort themselves). */
function stillWanted(itemId: number): void {
  if (active.get(itemId)?.ctrl.signal.aborted) throw new Cancelled();
}

// --- boot and the tick --------------------------------------------------------

export async function startPipeline(): Promise<void> {
  await recoverAfterRestart();
  setInterval(() => tick().catch((e) => console.error("pipeline tick", e)), 3000).unref();
  setInterval(() => cleanupWorktrees().catch((e) => console.error("worktree cleanup", e)), 6 * 3600 * 1000).unref();
  setTimeout(() => cleanupWorktrees().catch(() => {}), 60 * 1000).unref();
}

async function recoverAfterRestart(): Promise<void> {
  const n = await q("update runs set status = 'interrupted', finished_at = now(), error = 'interrupted by a restart' where status in ('running', 'queued') returning id");
  if (n.length) console.log(`pipeline: ${n.length} run(s) were interrupted by the restart`);
  const stuck = await q<Item>("select * from work_items where status = any($1)", [ACTIVE]);
  for (const it of stuck) {
    if (it.status === "planning") await setStatus(it.id, "inbox", { message: "the restart interrupted planning; it will start again" });
    else await setStatus(it.id, "blocked", { message: `the restart interrupted ${it.status}; retry to continue`, error: `interrupted during ${it.status}`, failedStage: stageOf(it.status) });
  }
}

/** The latest plan usage each runner reported: shown in the UI, and the tick holds back when a window is nearly spent. */
export const usage: Record<string, { fiveHour?: number; sevenDay?: number; resetsAt?: number; status?: string; at: string }> = {};
function recordUsage(runnerId: string, e: { fiveHour?: number; sevenDay?: number; resetsAt?: number; status?: string }): void {
  usage[runnerId] = { fiveHour: e.fiveHour, sevenDay: e.sevenDay, resetsAt: e.resetsAt, status: e.status, at: new Date().toISOString() };
}
export function throttled(runnerId: string, threshold: number): string | null {
  const u = usage[runnerId];
  if (!u) return null;
  if (u.resetsAt && u.resetsAt * 1000 < Date.now()) return null;
  if (u.status && u.status !== "allowed") return `the ${runnerId} plan reports "${u.status}"`;
  if ((u.fiveHour ?? 0) >= threshold) return `the ${runnerId} five-hour window is ${Math.round((u.fiveHour ?? 0) * 100)}% used`;
  if ((u.sevenDay ?? 0) >= 0.98) return `the ${runnerId} weekly window is ${Math.round((u.sevenDay ?? 0) * 100)}% used`;
  return null;
}

let lastThrottleNote = "";
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const s = await settings();
    if (s.paused) return;
    if (s.dailyBudgetUsd > 0) {
      const spent = (await spentToday()).total;
      if (spent >= s.dailyBudgetUsd) {
        const note = `today's spend ($${spent.toFixed(2)}) has reached the daily budget ($${s.dailyBudgetUsd.toFixed(2)})`;
        if (lastThrottleNote !== note) { lastThrottleNote = note; await emit({ type: "system", level: "warn", message: `holding new runs: ${note}` }); }
        return;
      }
    }
    const projects = new Map((await listProjects()).map((p) => [p.id, p]));
    const perProject = (pid: number) => [...active.values()].filter((a) => a.projectId === pid).length;
    const runnerHeld = (p: Project) => throttled(p.runner || process.env.RUNNER || "claude", s.usageThreshold);
    const inReview = new Map<number, number>();
    for (const r of await q<{ project_id: number; n: number }>("select project_id, count(*)::int as n from work_items where status in ('review', 'awaiting_approval') and project_id is not null group by project_id")) inReview.set(r.project_id, r.n);
    let free = s.maxConcurrentRuns - active.size;
    // Follow-ups first (a fix for a reviewer, a re-plan after an answer): they are closer to done.
    while (free > 0 && pending.length) {
      const i = pending.findIndex((p) => !active.has(p.itemId) && (projects.get(p.projectId)?.limits.concurrency ?? 1) > perProject(p.projectId) && !(projects.get(p.projectId) && runnerHeld(projects.get(p.projectId)!)));
      if (i < 0) break;
      const [job] = pending.splice(i, 1);
      free--;
      void job.fn().catch((e) => fail(job.itemId, e));
    }
    if (free <= 0) return;
    const candidates = await q<Item>("select * from work_items where status in ('queued', 'inbox') and project_id is not null and paused = false order by (status = 'queued') desc, priority, created_at limit 30");
    for (const it of candidates) {
      if (free <= 0) break;
      if (active.has(it.id) || pending.some((p) => p.itemId === it.id)) continue;
      const p = projects.get(it.project_id!);
      if (!p || p.paused || perProject(p.id) >= p.limits.concurrency) continue;
      const held = runnerHeld(p);
      if (held) { if (lastThrottleNote !== held) { lastThrottleNote = held; await emit({ type: "system", level: "warn", message: `holding new runs: ${held}` }); } continue; }
      // Review capacity is the real limit: do not start builds for a project whose reviewers are already behind.
      if (it.status === "queued" && (inReview.get(p.id) ?? 0) >= p.limits.maxInReview) continue;
      free--;
      if (it.status === "inbox") void plan(it, p).catch((e) => fail(it.id, e));
      else void build(it, p).catch((e) => fail(it.id, e));
    }
  } finally {
    ticking = false;
  }
}

/** A follow-up for an item. One that is still running is queued too: the tick starts the job once the slot is free. */
function enqueue(itemId: number, projectId: number, fn: () => Promise<void>): void {
  if (pending.some((p) => p.itemId === itemId)) return;
  pending.push({ itemId, projectId, fn });
  setTimeout(() => tick().catch(() => {}), 10).unref();
}

/** Which stage an item was in when it stopped, so a retry resumes there. */
const stageOf = (status: string): string => (status === "planning" ? "plan" : status === "merging" ? "merge" : status === "deploying" ? "deploy" : "build");

async function fail(itemId: number, err: unknown): Promise<void> {
  if (err instanceof Cancelled || err instanceof ItemClosed) { release(itemId); return; }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`item #${itemId}:`, message);
  release(itemId);
  const item = await getItem(itemId);
  if (!item || ["cancelled", "done", "failed"].includes(item.status)) return;
  await emit({ itemId, type: "error", level: "error", message });
  const blocked = await setStatus(itemId, "blocked", { message: `stopped: ${message.slice(0, 300)}`, error: message.slice(0, 4000), failedStage: err instanceof StageError ? err.stage : stageOf(item.status) });
  await postStatus(blocked, { text: `#${item.id} "${item.title}" needs a person: ${message.slice(0, 600)}`, level: "error", important: true });
}

// --- running an agent ---------------------------------------------------------


async function startRun(item: Item, p: Project, kind: RunKind, spec: RunSpec, opts: { small?: boolean } = {}): Promise<{ run: Run; result: RunResult }> {
  // The whole job, fix rounds included, may cost at most twice one run's budget; past that a person decides.
  if (kind !== "learn" && (await settings()).paused) throw new Error("the factory is paused");
  const spentSoFar = Number((await getItem(item.id))?.cost_usd ?? 0);
  if (kind !== "learn" && spentSoFar >= 2 * p.limits.maxBudgetUsd) throw new Error(`this job has already cost $${spentSoFar.toFixed(2)}, twice the run budget of $${p.limits.maxBudgetUsd}; raise the project's maxBudgetUsd or cancel it`);
  const runner = getRunner(p.runner);
  const model = spec.model ?? (runner.id === "claude" ? (opts.small ? SMALL_MODEL : p.model || DEFAULT_MODEL) : p.model || undefined);
  const effort = spec.effort ?? ((p.effort as RunSpec["effort"]) || (process.env.CLAUDE_EFFORT as RunSpec["effort"]) || undefined);
  // A stage (plan, build, a fix round) reserves the item's slot for all its runs and releases it
  // itself; a run started outside one (the learn run after a merge) takes the slot only for itself.
  const held = active.get(item.id);
  const owned = !held;
  const slot = held ?? reserve(item.id, p.id, kind);
  slot.kind = kind;
  const run = (await q<Run>(
    "insert into runs (item_id, kind, runner, model, effort, session_id, status, worktree, branch, prompt, started_at) values ($1, $2, $3, $4, $5, $6, 'running', $7, $8, $9, now()) returning *",
    [item.id, kind, runner.id, model ?? null, effort ?? null, spec.resumeSessionId ?? spec.sessionId ?? null, spec.cwd, item.branch, `${spec.systemPrompt ? `[system]\n${spec.systemPrompt}\n\n[prompt]\n` : ""}${spec.prompt}`],
  ))[0];
  slot.runId = run.id;
  await emit({ itemId: item.id, runId: run.id, type: "run", message: `${kind} run started (${runner.label}${model ? `, ${model}` : ""}${spec.resumeSessionId ? ", resumed" : ""})`, data: { runId: run.id, kind, runner: runner.id, model, status: "running" } });
  // The run's events are written one after another: fired off unawaited, a tool's result could land before the call.
  let writes: Promise<unknown> = Promise.resolve();
  const write = (ev: Parameters<typeof emit>[0]) => { writes = writes.then(() => emit({ itemId: item.id, runId: run.id, actor: runner.id, ...ev })).catch((err) => console.error("event write failed", err)); };
  // This run's own stop handle: the slot's cancel reaches it, and the loop guard below pulls it
  // without cancelling the whole stage.
  const ctrl = new AbortController();
  const onSlotAbort = () => ctrl.abort();
  if (slot.ctrl.signal.aborted) ctrl.abort(); else slot.ctrl.signal.addEventListener("abort", onSlotAbort, { once: true });
  let lastCall = "", repeats = 0, looped = false;
  const calls = new Map<string, string>(); // tool-use id -> what it asked for, to name a refused one
  const onEvent = (e: RunEvent) => {
    if (e.type === "init") { q("update runs set session_id = $2 where id = $1", [run.id, e.sessionId]).catch(() => {}); write({ type: "log", level: "debug", message: `session ${e.sessionId}${e.model ? ` on ${e.model}` : ""}`, actor: "factory" }); }
    else if (e.type === "text") write({ type: "text", message: e.text.slice(0, 20000) });
    else if (e.type === "tool_use") {
      write({ type: "tool", message: `${e.name}: ${toolSummary(e.name, e.input)}`, data: { name: e.name, id: e.id, input: JSON.stringify(e.input ?? {}).slice(0, 6000) } });
      if (e.id) calls.set(e.id, toolSummary(e.name, e.input).split("\n")[0].slice(0, 200));
      // The same call four times in a row is a loop, not progress: stop it before it burns the budget.
      const key = `${e.name}:${JSON.stringify(e.input ?? {})}`;
      repeats = key === lastCall ? repeats + 1 : 1;
      lastCall = key;
      if (repeats >= LOOP_LIMIT && !looped) { looped = true; write({ type: "error", level: "error", message: `stopped: ${e.name} was called ${repeats} times in a row with the same input` }); ctrl.abort(); }
    }
    else if (e.type === "tool_result") write({ type: "tool_result", level: e.isError ? "warn" : "debug", message: e.output.slice(0, 3000), data: { id: e.id, isError: Boolean(e.isError) } });
    else if (e.type === "log") write({ type: "log", level: e.level, message: e.message, actor: "factory" });
    // The CLI's own wording is a paragraph addressed to the agent; the summary at the end says what to change.
    else if (e.type === "denied") write({ type: "log", level: "info", message: `refused: ${e.tool}${e.id && calls.get(e.id) ? ` ${calls.get(e.id)}` : ""}`, data: { reason: e.message?.slice(0, 2000) } });
    else if (e.type === "usage") recordUsage(runner.id, e);
  };
  let result: RunResult;
  try {
    result = await runner.run({ ...spec, model, effort }, onEvent, ctrl.signal);
  } catch (e) {
    result = { ok: false, durationMs: Date.now() - slot.startedAt, exitCode: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    slot.ctrl.signal.removeEventListener("abort", onSlotAbort);
    if (owned) release(item.id);
  }
  if (looped && result.error === "cancelled") result = { ...result, ok: false, error: `loop: the same tool call repeated ${LOOP_LIMIT} times` };
  await writes;
  const status = result.error === "cancelled" ? "cancelled" : result.ok ? "succeeded" : "failed";
  await q(
    "update runs set status = $2, session_id = coalesce($3, session_id), result = $4, structured = $5, cost_usd = $6, turns = $7, usage = $8, exit_code = $9, error = $10, finished_at = now() where id = $1",
    [run.id, status, result.sessionId ?? null, (result.result ?? "").slice(0, 100000), result.structured === undefined ? null : JSON.stringify(result.structured), result.costUsd ?? null, result.turns ?? null, JSON.stringify({ ...(result.usage as object ?? {}), denials: result.denials ?? [], stderr: result.stderr?.slice(-2000) }), result.exitCode, result.error ?? null],
  );
  await addCost(item.id, result.costUsd, result.turns);
  const refused = refusalSummary(result.denials ?? [], spec.tools?.mode);
  if (refused) await emit({ itemId: item.id, runId: run.id, type: "log", level: "warn", actor: "factory", message: refused, data: { denials: result.denials } });
  await emit({ itemId: item.id, runId: run.id, type: "run", level: result.ok ? "info" : "warn", message: `${kind} run ${status}${result.turns ? ` after ${result.turns} turns` : ""}${result.costUsd != null ? ` ($${result.costUsd.toFixed(2)} api-equivalent)` : ""}${result.error ? `: ${result.error}` : ""}`, data: { runId: run.id, kind, status, costUsd: result.costUsd, turns: result.turns, durationMs: result.durationMs, denials: result.denials?.length ?? 0 } });
  if (result.error === "cancelled") throw new Cancelled();
  return { run: { ...run, session_id: result.sessionId ?? run.session_id, result: result.result ?? null, structured: result.structured }, result };
}

const fmtFeedback = (fb: Feedback[]) => fb.map((f) => `- ${f.author ?? f.source}${f.kind !== "comment" ? ` (${f.kind.replace("_", " ")})` : ""}: ${f.body}`).join("\n");
const forPrompt = (item: Item) => ({ id: item.id, title: item.title, body: item.body, kind: item.kind, priority: item.priority, labels: item.labels, requester_name: item.requester_name, external_url: item.external_url, plan: item.plan });

async function ensureWorktree(item: Item, p: Project): Promise<Item> {
  if (item.worktree && fs.existsSync(item.worktree) && item.base_sha) return item;
  const branch = item.branch ?? branchName(item.id, item.title);
  const reuse = Boolean(item.head_sha && item.base_sha && item.head_sha !== item.base_sha);
  const w = await createWorktree(p, item.id, branch, (m) => log(item.id, null, m), { reuseBranch: reuse, baseSha: reuse ? item.base_sha : null });
  await saveBranch(item.id, { branch, worktree: w.worktree, baseSha: w.baseSha });
  await emit({ itemId: item.id, type: "git", message: `branch ${branch}${reuse ? " (kept from the earlier attempt)" : ` from ${w.baseSha.slice(0, 7)}`}`, data: { branch, baseSha: w.baseSha, worktree: w.worktree } });
  return (await getItem(item.id))!;
}

// --- plan -----------------------------------------------------------------------

async function plan(item: Item, p: Project): Promise<void> {
  reserve(item.id, p.id, "plan");
  try {
    item = await setStatus(item.id, "planning", { message: "reading the request and the repository" });
    item = await ensureWorktree(item, p);
    const notes = (await notesFor(p.id)).map((n) => n.body);
    const all = await feedbackFor(item.id);
    const unhandled = all.filter((f) => !f.handled_at);
    const earlier = await lastRun(item.id, ["plan"]);
    const resume = earlier?.session_id && unhandled.length && getRunner(p.runner).capabilities.resume ? earlier.session_id : undefined;
    const prompt = resume
      ? `The requester answered:\n${fmtFeedback(unhandled)}\n\nUpdate the plan with that and answer again with the JSON object the schema asks for.`
      : planPrompt(forPrompt(item), p, notes, all.map((f) => ({ author: f.author, body: f.body })));
    const { result } = await startRun(item, p, "plan", { cwd: item.worktree!, prompt, systemPrompt: houseRules(p, "readonly"), schema: PLAN_SCHEMA, tools: { mode: "readonly", allow: p.tools.allow, deny: p.tools.deny }, ...access(p), env: p.env, maxTurns: 60, maxBudgetUsd: Math.min(p.limits.maxBudgetUsd, 3), timeoutMs: 25 * 60 * 1000, resumeSessionId: resume });
    stillWanted(item.id);
    await markHandled(unhandled.map((f) => f.id));
    const plan = result.structured as Plan | undefined;
    if (!result.ok || !plan || typeof plan !== "object" || !plan.summary) throw new Error(`planning failed: ${result.error ?? "no plan came back"}`);
    plan.questions ??= []; plan.steps ??= []; plan.files ??= []; plan.tests ??= []; plan.risks ??= []; plan.acceptance ??= [];
    await savePlan(item.id, plan);
    await emit({ itemId: item.id, type: "note", message: plan.summary, data: { plan } });
    item = (await getItem(item.id))!;
    if (plan.clarity === "needs_info" && plan.questions.length) {
      item = await setStatus(item.id, "needs_info", { message: "waiting for the requester to answer" });
      await postStatus(item, { text: `I need a little more to go on for #${item.id} "${item.title}":\n${plan.questions.map((qq) => `• ${qq}`).join("\n")}\nReply here and I will carry on.`, level: "warning", important: true });
      return;
    }
    const steps = plan.steps.slice(0, 8).map((s, i) => `${i + 1}. ${s}`).join("\n");
    if (gateIsManual(p.gates.plan, plan.risk)) {
      const a = await requestApproval(item.id, "plan", plan.summary, plan);
      item = await setStatus(item.id, "awaiting_approval", { gate: "plan", message: "plan ready, waiting for approval" });
      await postStatus(item, { text: `Plan for #${item.id} "${item.title}" (${plan.size}, ${plan.risk} risk, ~${plan.estimate_minutes} min):\n${plan.summary}\n\n${steps}\n\nApprove to build.`, important: true, buttons: [{ text: "Approve", data: `approve:${a.id}` }, { text: "Reject", data: `reject:${a.id}` }] });
    } else {
      item = await setStatus(item.id, "queued", { message: `plan accepted automatically (${p.gates.plan === "auto" ? "gate is automatic" : `${plan.risk} risk`}); waiting for a build slot` });
      await postStatus(item, { text: `#${item.id} "${item.title}" planned (${plan.size}, ${plan.risk} risk): ${plan.summary}\nBuilding next.` });
    }
  } finally {
    release(item.id);
  }
}

// --- build, verify, review, deliver ------------------------------------------------

async function build(item: Item, p: Project): Promise<void> {
  reserve(item.id, p.id, "build");
  try {
    item = await setStatus(item.id, "building", { message: "building" });
    item = await ensureWorktree(item, p);
    const notes = (await notesFor(p.id)).map((n) => n.body);
    const fb = await feedbackFor(item.id);
    const prompt = buildPrompt(forPrompt(item), p, notes, fb.map((f) => ({ author: f.author, body: f.body })));
    const { result } = await startRun(item, p, "build", { cwd: item.worktree!, prompt, systemPrompt: houseRules(p), tools: p.tools, ...access(p), env: p.env, maxTurns: p.limits.maxTurns, maxBudgetUsd: p.limits.maxBudgetUsd, timeoutMs: p.limits.maxMinutes * 60 * 1000 });
    await markHandled(fb.filter((f) => !f.handled_at).map((f) => f.id));
    stillWanted(item.id);
    const s = await settle(item.worktree!, item.base_sha!, `#${item.id} ${item.title}`);
    await saveBranch(item.id, { headSha: s.headSha });
    await emit({ itemId: item.id, type: "git", message: s.commits ? `${s.commits} commit(s), ${s.files.length} file(s)${s.committedForAgent ? " (uncommitted changes were committed by the factory)" : ""}` : "no changes were made", data: { commits: s.commits, files: s.files.slice(0, 200), headSha: s.headSha } });
    if (s.commits === 0) throw new Error(`the agent made no changes${result.error ? ` (${result.error})` : ""}. It said: ${(result.result ?? "").slice(0, 800) || "nothing"}`);
    if (!result.ok) log(item.id, null, `the build run ended with ${result.error}, but it left ${s.commits} commit(s); verifying them`, "warn");
    await verifyReviewDeliver((await getItem(item.id))!, p, result.result ?? "");
  } finally {
    release(item.id);
  }
}

async function verify(item: Item, p: Project): Promise<{ ok: boolean; output: string; summary: string }> {
  const cmds = [p.build_command, p.test_command].filter((c): c is string => Boolean(c && c.trim()));
  if (!cmds.length) {
    await emit({ itemId: item.id, type: "verify", message: "no verification command is configured for this project; relying on the agent's own checks", level: "warn" });
    return { ok: true, output: "", summary: "no verification command configured" };
  }
  const outputs: string[] = [];
  for (const cmd of cmds) {
    const r = await shell(cmd, { cwd: item.worktree!, timeoutMs: p.limits.verifyMinutes * 60 * 1000, env: p.env, signal: active.get(item.id)?.ctrl.signal });
    stillWanted(item.id);
    const out = tail(`${r.stdout}\n${r.stderr}`.trim(), 6000);
    const ok = r.code === 0 && !r.timedOut;
    await emit({ itemId: item.id, type: "verify", level: ok ? "info" : "error", message: `${ok ? "passed" : r.timedOut ? "timed out" : `failed (${r.code})`}: ${cmd} (${Math.round(r.durationMs / 1000)}s)`, data: { command: cmd, code: r.code, timedOut: r.timedOut, output: out } });
    outputs.push(`$ ${cmd}\n${out}`);
    if (!ok) return { ok: false, output: outputs.join("\n\n"), summary: `${cmd} ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}` };
  }
  return { ok: true, output: outputs.join("\n\n"), summary: `${cmds.map((c) => `\`${c}\``).join(" and ")} passed` };
}

async function fixRun(item: Item, p: Project, reason: "verify" | "review" | "feedback" | "conflict", detail: string): Promise<{ result: RunResult; commits: number }> {
  const last = await lastRun(item.id, ["build", "fix"]);
  const runner = getRunner(p.runner);
  const resume = runner.capabilities.resume && last?.session_id ? last.session_id : undefined;
  const base = resume ? "" : `${buildPrompt(forPrompt(item), p, [], [])}\n\n---\n\n`;
  const prompt = `${base}${fixPrompt(forPrompt(item), reason, detail)}`;
  const before = item.head_sha ?? item.base_sha!;
  const { result } = await startRun(item, p, "fix", { cwd: item.worktree!, prompt, systemPrompt: houseRules(p), tools: p.tools, ...access(p), env: p.env, maxTurns: Math.max(30, Math.round(p.limits.maxTurns / 2)), maxBudgetUsd: Math.max(1, p.limits.maxBudgetUsd / 2), timeoutMs: p.limits.maxMinutes * 60 * 1000, resumeSessionId: resume });
  const s = await settle(item.worktree!, item.base_sha!, `#${item.id} follow-up: ${reason}`);
  await saveBranch(item.id, { headSha: s.headSha });
  const newCommits = s.headSha === before ? 0 : Number((await git(["rev-list", "--count", `${before}..HEAD`], item.worktree!).catch(() => "0")) || 0);
  await emit({ itemId: item.id, type: "git", message: newCommits ? `${newCommits} new commit(s) from the follow-up` : "the follow-up changed nothing", data: { commits: newCommits, headSha: s.headSha } });
  return { result, commits: newCommits };
}

/** After the build (or a fix): verify, get a second opinion, then push and open the pull request. */
async function verifyReviewDeliver(item: Item, p: Project, finalMessage: string): Promise<void> {
  let message = finalMessage;
  let verifySummary = "";
  let reviewed = false;
  let concerns = false; // the AI review did not answer, or still wants changes when the fix rounds are spent
  for (;;) {
    stillWanted(item.id);
    item = await setStatus(item.id, "verifying", { message: "running the project's verification" });
    const v = await verify(item, p);
    verifySummary = v.summary;
    if (!v.ok) {
      await bumpRounds(item.id, "verify_rounds");
      item = (await getItem(item.id))!;
      if (item.verify_rounds > p.limits.maxFixRounds) throw new Error(`verification still fails after ${p.limits.maxFixRounds} fix rounds: ${v.summary}`);
      item = await setStatus(item.id, "fixing", { message: `verification failed (${v.summary}); fix round ${item.verify_rounds}` });
      const f = await fixRun(item, p, "verify", v.output);
      item = (await getItem(item.id))!;
      if (!f.commits && !f.result.ok) throw new Error(`the fix run changed nothing and ended with ${f.result.error}`);
      message = f.result.result || message;
      continue;
    }
    if (p.gates.review === "ai" && !reviewed) {
      reviewed = true;
      item = await setStatus(item.id, "reviewing", { message: "a second agent is reviewing the diff" });
      const rv = await aiReview(item, p, message, v);
      const serious = rv?.findings?.filter((f) => f.severity === "blocker" || f.severity === "major") ?? [];
      concerns = !rv || (rv.verdict === "request_changes" && serious.length > 0);
      if (rv?.verdict === "request_changes" && serious.length) {
        await bumpRounds(item.id, "fix_rounds");
        item = (await getItem(item.id))!;
        if (item.fix_rounds <= p.limits.maxFixRounds) {
          item = await setStatus(item.id, "fixing", { message: `the reviewer asked for changes (${serious.length} finding(s)); fix round ${item.fix_rounds}` });
          const detail = `${rv.summary}\n\n${serious.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`).join("\n")}`;
          const f = await fixRun(item, p, "review", detail);
          item = (await getItem(item.id))!;
          message = f.result.result || message;
          concerns = false;
          continue; // verify again, no second review
        }
      }
    }
    break;
  }
  stillWanted(item.id);
  await deliver((await getItem(item.id))!, p, message, verifySummary, { reviewConcerns: concerns });
}

async function aiReview(item: Item, p: Project, finalMessage: string, verified: { summary: string; output: string }): Promise<{ verdict: string; summary: string; findings: Array<{ severity: string; file: string; line?: number; message: string }> } | null> {
  const d = await diff(item.worktree!, item.base_sha!, 150_000);
  const prompt = reviewPrompt(forPrompt(item), p, d.truncated ? `${d.patch}\n… (diff truncated)` : d.patch, finalMessage, verified);
  try {
    const { result } = await startRun(item, p, "review", { cwd: item.worktree!, prompt, schema: REVIEW_SCHEMA, tools: { mode: "readonly" }, maxTurns: 30, maxBudgetUsd: Math.min(p.limits.maxBudgetUsd, 2), timeoutMs: 15 * 60 * 1000 }, { small: true });
    const rv = result.structured as { verdict: string; summary: string; findings: Array<{ severity: string; file: string; line?: number; message: string }> } | undefined;
    if (!result.ok || !rv) { log(item.id, null, `the review run did not answer (${result.error ?? "no verdict"}); continuing without it`, "warn"); return null; }
    rv.findings ??= [];
    await emit({ itemId: item.id, type: "note", level: rv.verdict === "approve" ? "info" : "warn", message: `review: ${rv.verdict.replace("_", " ")} — ${rv.summary}`, data: { review: rv } });
    return rv;
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    log(item.id, null, `review skipped: ${e instanceof Error ? e.message : String(e)}`, "warn");
    return null;
  }
}

async function deliver(item: Item, p: Project, finalMessage: string, verifySummary: string, opts: { reviewConcerns?: boolean } = {}): Promise<void> {
  const brief = finalMessage.trim().slice(0, 700) + (finalMessage.length > 700 ? "…" : "");
  const remote = await hasRemote(repoDir(p));
  const onGithub = remote ? Boolean(await githubRepo(repoDir(p))) : false;
  if (p.delivery === "pr" && remote && !onGithub) {
    // A remote that is not GitHub: no pull request to open, but the branch is pushed so nothing lives only on this Mac.
    await push(item.worktree!, item.branch!);
    await emit({ itemId: item.id, type: "git", message: `pushed ${item.branch}; the remote is not GitHub, so the review happens here`, level: "warn" });
  }
  if (p.delivery === "pr" && onGithub) {
    await push(item.worktree!, item.branch!);
    stillWanted(item.id);
    await emit({ itemId: item.id, type: "git", message: `pushed ${item.branch}` });
    if (!item.pr_url) {
      const verifyEv = await q<{ data: { output?: string } }>("select data from events where item_id = $1 and type = 'verify' order by id desc limit 1", [item.id]);
      const runCount = await one<{ n: number; model: string | null }>("select count(*)::int as n, max(model) as model from runs where item_id = $1 and kind in ('build', 'fix')", [item.id]);
      const evidence = { verifyOutput: verifyEv[0]?.data?.output ?? "", commits: await commitLog(item.worktree!, item.base_sha!), costUsd: Number(item.cost_usd), model: runCount?.model ?? p.model ?? undefined, runs: runCount?.n ?? 1 };
      const pr = await openPr(item.worktree!, p.default_branch, `${item.title} (#${item.id})`, prBody(forPrompt(item), finalMessage, verifySummary, itemLink(item.id), evidence));
      await saveBranch(item.id, { prUrl: pr.url, prNumber: pr.number });
      stillWanted(item.id);
      await emit({ itemId: item.id, type: "git", message: `pull request opened: ${pr.url}`, data: { url: pr.url, number: pr.number } });
      item = (await getItem(item.id))!;
      item = await setStatus(item.id, "review", { message: "pull request open, waiting for review" });
      await postStatus(item, { text: `#${item.id} "${item.title}" is ready for review: ${pr.url}\n${brief}`, level: "success", important: true, buttons: [{ text: "Open PR", url: pr.url }] });
    } else {
      item = await setStatus(item.id, "review", { message: "pull request updated, waiting for review" });
      await postStatus(item, { text: `#${item.id}: pushed an update to ${item.pr_url}\n${brief}`, level: "success", important: true, buttons: [{ text: "Open PR", url: item.pr_url! }] });
    }
    await pickUpFeedback(item, p);
    return;
  }
  const logText = await commitLog(item.worktree!, item.base_sha!);
  const waiting = await openFeedback(item.id);
  if (!gateIsManual(p.gates.merge, item.risk) && !opts.reviewConcerns && !waiting.length) {
    // No pull request for anyone to review and the merge gate is automatic: verified (and reviewed, when the AI review is on) is enough.
    await postStatus(item, { text: `#${item.id} "${item.title}" is built and verified (${verifySummary}); merging into ${p.default_branch} (the merge gate is ${p.gates.merge}).\n${logText.split("\n").slice(0, 6).join("\n")}\n${brief}`, level: "success" });
    await merge(item, p);
    return;
  }
  item = await setStatus(item.id, "review", { message: `built and verified; review the diff in the factory and approve to merge${opts.reviewConcerns ? " (the AI reviewer still has concerns)" : ""}` });
  await postStatus(item, { text: `#${item.id} "${item.title}" is built and verified (${verifySummary}). Review the diff and approve to merge into ${p.default_branch}.\n${logText.split("\n").slice(0, 6).join("\n")}\n${brief}`, level: "success", important: true, buttons: [{ text: "Approve", data: `review-approve:${item.id}` }, { text: "Review", url: itemLink(item.id) }] });
  await pickUpFeedback(item, p);
}

/** Comments that were not acted on yet (an approval is not something to act on). */
const openFeedback = async (itemId: number) => (await unhandledFeedback(itemId)).filter((f) => f.kind !== "approved");

/** Feedback that arrived while the item was building or being fixed was kept, not acted on: back in review, it starts the next round. */
async function pickUpFeedback(item: Item, p: Project): Promise<void> {
  const open = await openFeedback(item.id);
  if (!open.length) return;
  log(item.id, null, `${open.length} comment(s) arrived while the job ran; starting another round`);
  await fixFromFeedback(item, p);
}

// --- what comes back: approvals, reviews, answers ------------------------------------

export async function onApproval(a: Approval, decision: "approved" | "rejected", note: string | undefined, by: { name: string }): Promise<void> {
  const item = await mustItem(a.item_id);
  const p = await mustProject(item.project_id);
  if (decision === "rejected") {
    if (a.kind === "plan") {
      const it = await setStatus(item.id, "cancelled", { message: `plan rejected by ${by.name}${note ? `: ${note}` : ""}`, actor: by.name });
      await finish(it, p, "cancelled", `the plan was rejected${note ? `: ${note}` : ""}`);
    } else {
      const it = await setStatus(item.id, "blocked", { message: `${a.kind} rejected by ${by.name}${note ? `: ${note}` : ""}`, error: `${a.kind} rejected${note ? `: ${note}` : ""}`, actor: by.name, failedStage: a.kind });
      await postStatus(it, { text: `#${item.id}: ${a.kind} was declined by ${by.name}${note ? ` (${note})` : ""}. It is parked until someone retries or cancels it.`, level: "warning" });
    }
    return;
  }
  if (a.kind === "plan") {
    await setStatus(item.id, "queued", { message: `plan approved by ${by.name}; waiting for a build slot`, actor: by.name });
    setTimeout(() => tick().catch(() => {}), 10).unref();
  } else if (a.kind === "merge") void merge(item, p).catch((e) => fail(item.id, e));
  else if (a.kind === "deploy") void deploy(item, p).catch((e) => fail(item.id, e));
}

export async function decide(approvalId: number, decision: "approved" | "rejected", by: { userId?: number | null; via: string; name: string }, note?: string): Promise<Approval> {
  const a = await decideApproval(approvalId, decision, by, note);
  await onApproval(a, decision, note, by);
  return a;
}

/** A reviewer's verdict on the built change: from the factory UI, Telegram, or the pull request. */
export async function reviewDecision(itemId: number, decision: "approved" | "changes_requested", body: string, by: { userId?: number | null; via: string; name: string; externalId?: string | null }): Promise<void> {
  const item = await mustItem(itemId);
  if (item.status !== "review") throw new Error(`#${itemId} is ${item.status}, not in review`);
  const p = await mustProject(item.project_id);
  await addFeedback(itemId, { source: by.via, author: by.name, body: body || (decision === "approved" ? "approved" : "changes requested"), kind: decision, externalId: by.externalId ?? null });
  if (decision === "approved") await toMergeGate(item, p, by.name);
  else await fixFromFeedback(item, p);
}

/** A comment, from wherever: during review it becomes a fix round; while waiting for answers it re-plans; otherwise it is kept for the next run. */
export async function onComment(itemId: number, fb: { source: string; author?: string | null; body: string; externalId?: string | null; kind?: Feedback["kind"] }): Promise<Feedback | null> {
  const item = await mustItem(itemId);
  const f = await addFeedback(itemId, { ...fb, kind: fb.kind ?? (item.status === "needs_info" ? "answer" : "comment") });
  if (!f) return null;
  const p = await getProject(item.project_id);
  if (!p) return f;
  if (item.status === "needs_info") await setStatus(itemId, "inbox", { message: `${f.author ?? fb.source} answered; planning again`, actor: f.author ?? fb.source });
  else if (item.status === "review" && f.kind !== "approved") await fixFromFeedback(item, p);
  else if (f.kind === "approved" && item.status === "review") await toMergeGate(item, p, f.author ?? fb.source);
  return f;
}

async function fixFromFeedback(item: Item, p: Project): Promise<void> {
  enqueue(item.id, p.id, async () => {
    reserve(item.id, p.id, "fix");
    try {
      let it = (await getItem(item.id))!;
      if (it.status !== "review") return;
      const fb = await unhandledFeedback(it.id);
      if (!fb.length) return;
      await bumpRounds(it.id, "fix_rounds");
      it = (await getItem(it.id))!;
      if (it.fix_rounds > p.limits.maxFixRounds) throw new Error(`already went through ${p.limits.maxFixRounds} fix rounds; a person should take it from here`);
      it = await setStatus(it.id, "fixing", { message: `addressing review feedback (round ${it.fix_rounds})` });
      const f = await fixRun(it, p, "review", fmtFeedback(fb));
      await markHandled(fb.map((x) => x.id));
      it = (await getItem(it.id))!;
      if (!f.commits) {
        it = await setStatus(it.id, "review", { message: "the follow-up made no code changes; back in review" });
        await postStatus(it, { text: `#${it.id}: looked at the feedback but changed nothing. ${(f.result.result ?? "").slice(0, 600)}`, level: "warning", important: true });
        return;
      }
      await verifyReviewDeliver(it, p, f.result.result ?? "");
    } finally {
      release(item.id);
    }
  });
}

async function toMergeGate(item: Item, p: Project, who: string): Promise<void> {
  const open = (await unhandledFeedback(item.id)).filter((f) => f.kind === "changes_requested");
  if (open.length) { log(item.id, null, `${who} approved, but there are unaddressed change requests; fixing those first`); await fixFromFeedback(item, p); return; }
  if (gateIsManual(p.gates.merge, item.risk)) {
    const a = await requestApproval(item.id, "merge", `Merge #${item.id} into ${p.default_branch}${item.pr_url ? ` (${item.pr_url})` : ""}`);
    const it = await setStatus(item.id, "awaiting_approval", { gate: "merge", message: `reviewed by ${who}; waiting for the go-ahead to merge` });
    await postStatus(it, { text: `#${it.id} "${it.title}" was approved by ${who}. Merge into ${p.default_branch}?`, important: true, buttons: [{ text: "Merge", data: `approve:${a.id}` }, { text: "Hold", data: `reject:${a.id}` }] });
  } else {
    await emit({ itemId: item.id, type: "status", message: `approved by ${who}; merging (gate is ${p.gates.merge})`, data: { status: item.status } });
    void merge(item, p).catch((e) => fail(item.id, e));
  }
}

async function merge(item: Item, p: Project): Promise<void> {
  // Two approvals at once (a button and the pull request) must not merge twice: whoever claims the item merges.
  // From review or a gate, from a verified build when the merge gate is automatic, or from a retry.
  const claimed = await claim(item.id, ["review", "awaiting_approval", "blocked", "verifying", "reviewing"], "merging", "merging");
  if (!claimed) { log(item.id, null, "merge skipped: the item moved on already", "warn"); return; }
  item = claimed;
  // Called from inside a stage that holds the slot (an automatic merge after the build) or on its own (a person's go-ahead).
  const owned = !active.has(item.id);
  if (owned) reserve(item.id, p.id, "merge");
  try {
    const isPr = p.delivery === "pr" && Boolean(item.pr_number);
    // At most a few rounds of "bring the branch up to date, then land it": the base can move while we work.
    for (let round = 0; ; round++) {
      if (!isPr && item.worktree && (await withRepoLock(repoDir(p), () => baseMoved(item, p)))) {
        if (round >= 3) throw new StageError("merge", `${p.default_branch} keeps moving while the job tries to land; try again when it is quieter`);
        await emit({ itemId: item.id, type: "git", message: `${p.default_branch} moved while the job waited; bringing the branch up to date before landing` });
        await reconcile(item, p);
        item = (await getItem(item.id))!;
        continue;
      }
      try {
        if (isPr) {
          const out = await mergePr(item.worktree!, item.pr_number!, "squash", await githubRepo(repoDir(p)));
          await emit({ itemId: item.id, type: "git", message: `merged ${item.pr_url}`, data: { out: out.slice(0, 500) } });
        } else {
          const r = await mergeLocal(p, item.branch!, `Merge #${item.id}: ${item.title}`);
          await emit({ itemId: item.id, type: "git", message: `merged into ${p.default_branch} at ${r.sha.slice(0, 7)}`, data: { sha: r.sha } });
        }
      } catch (e) {
        if (e instanceof Cancelled || e instanceof ItemClosed || !isConflict(e) || !item.worktree || round >= 3) throw e;
        // The base moved under the job: bring the branch up to date (with the agent's help if it conflicts) and land it again.
        await emit({ itemId: item.id, type: "git", level: "warn", message: `the merge conflicted: ${p.default_branch} moved while the job waited; bringing the branch up to date` });
        await reconcile(item, p);
        item = (await getItem(item.id))!;
        continue;
      }
      stillWanted(item.id);
      break;
    }
  } finally {
    if (owned) release(item.id);
  }
  // What follows the landing (the deploy gate, the deploy) fails as its own stage, never as "merge".
  await afterMerge((await getItem(item.id))!, p);
}

/** Has the branch the job lands on gained commits the job's branch does not contain? */
async function baseMoved(item: Item, p: Project): Promise<boolean> {
  const dir = repoDir(p);
  if (await hasRemote(dir)) await run("git", ["fetch", "--prune", "--quiet"], { cwd: dir, timeoutMs: 120000 }); // caller holds the repo lock
  const base = await baseRef(dir, p.default_branch);
  const tip = (await run("git", ["rev-parse", base], { cwd: dir, timeoutMs: 20000 })).stdout.trim();
  const common = (await run("git", ["merge-base", "HEAD", base], { cwd: item.worktree!, timeoutMs: 20000 })).stdout.trim();
  return Boolean(tip && common && tip !== common);
}

/** Merges the base into the job's branch; conflicts go to the agent; then verify and merge again. Runs inside merge()'s slot. */
async function reconcile(item: Item, p: Project): Promise<void> {
  try {
    await reconcileNow(item, p);
  } catch (e) {
    if (e instanceof Cancelled || e instanceof ItemClosed || e instanceof StageError) throw e;
    if (item.worktree) await run("git", ["merge", "--abort"], { cwd: item.worktree, timeoutMs: 60000 }); // never leave markers behind
    throw new StageError("merge", e instanceof Error ? e.message : String(e));
  }
}

async function reconcileNow(item: Item, p: Project): Promise<void> {
  item = await setStatus(item.id, "fixing", { message: `merging ${p.default_branch} into the branch` });
  const before = (await run("git", ["rev-parse", "HEAD"], { cwd: item.worktree!, timeoutMs: 20000 })).stdout.trim();
  const r = await reconcileWithBase(p, item.worktree!);
  if (r.clean) {
    await emit({ itemId: item.id, type: "git", message: `${r.base} merged into the branch cleanly` });
  } else {
    // Only a conflict costs a fix round; a clean sync is free.
    await bumpRounds(item.id, "fix_rounds");
    item = (await getItem(item.id))!;
    if (item.fix_rounds > p.limits.maxFixRounds) throw new Error(`the branch keeps conflicting with ${p.default_branch} after ${p.limits.maxFixRounds} rounds; reconcile it by hand`);
    await emit({ itemId: item.id, type: "git", level: "warn", message: `conflicts in ${r.conflicted.join(", ")}; asking the agent to resolve them (round ${item.fix_rounds})` });
    await fixRun(item, p, "conflict", `Conflicted files:\n${r.conflicted.map((x) => `- ${x}`).join("\n")}\n\nThe other side is ${r.base}; yours is this branch (#${item.id}: ${item.title}).`);
    const left = (await run("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: item.worktree!, timeoutMs: 60000 })).stdout.trim();
    if (left) throw new Error(`conflicts are still unresolved in ${left.split("\n").join(", ")}`);
  }
  stillWanted(item.id);
  item = (await getItem(item.id))!;
  let v = await verify(item, p);
  if (!v.ok) {
    // The two sides disagree in a way the tests catch: one fix round, as after a build.
    await bumpRounds(item.id, "verify_rounds");
    item = (await getItem(item.id))!;
    if (item.verify_rounds <= p.limits.maxFixRounds) {
      item = await setStatus(item.id, "fixing", { message: `verification failed after merging ${p.default_branch} (${v.summary}); fix round ${item.verify_rounds}` });
      await fixRun(item, p, "verify", v.output);
      item = (await getItem(item.id))!;
      v = await verify(item, p);
    }
    if (!v.ok) {
      // Never leave a failing combination on the branch: drop the base merge, and let a retry build again.
      await run("git", ["reset", "--hard", before], { cwd: item.worktree!, timeoutMs: 60000 });
      throw new StageError("build", `after bringing the branch up to date, verification fails (${v.summary}); the base merge was undone`);
    }
  }
  if (p.delivery === "pr" && item.pr_number) { await push(item.worktree!, item.branch!); await emit({ itemId: item.id, type: "git", message: `pushed ${item.branch} (updated)` }); }
  await setStatus(item.id, "merging", { message: `up to date with ${p.default_branch}; landing it`, data: { reconciled: true } });
}

/** Also called when a pull request was merged by hand. */
export async function afterMerge(item: Item, p: Project): Promise<void> {
  if (p.deploy_command && p.gates.deploy !== "off") {
    if (p.gates.deploy === "auto") { await deploy(item, p); return; }
    const a = await requestApproval(item.id, "deploy", `Deploy ${p.name}: ${p.deploy_command}`);
    const it = await setStatus(item.id, "awaiting_approval", { gate: "deploy", message: "merged; waiting for the go-ahead to deploy" });
    await postStatus(it, { text: `#${it.id} "${it.title}" is merged. Deploy ${p.name} now (\`${p.deploy_command}\`)?`, important: true, buttons: [{ text: "Deploy", data: `approve:${a.id}` }, { text: "Later", data: `reject:${a.id}` }] });
    return;
  }
  await finish(await setStatus(item.id, "done", { message: "merged" }), p, "done", "merged");
}

async function deploy(item: Item, p: Project): Promise<void> {
  const claimed = await claim(item.id, ["merging", "awaiting_approval", "blocked", "review"], "deploying", `deploying: ${p.deploy_command}`);
  if (!claimed) { log(item.id, null, "deploy skipped: the item moved on already", "warn"); return; }
  item = claimed;
  const owned = !active.has(item.id);
  const slot = active.get(item.id) ?? reserve(item.id, p.id, "deploy");
  try {
    await deployWith(item, p, slot.ctrl.signal);
  } finally {
    if (owned) release(item.id);
  }
}

async function deployWith(item: Item, p: Project, signal: AbortSignal): Promise<void> {
  const dir = repoDir(p);
  if (!p.local_path) {
    await withRepoLock(dir, async () => {
      await git(["checkout", "--quiet", p.default_branch], dir);
      await git(["pull", "--quiet", "--ff-only"], dir, { timeoutMs: 5 * 60 * 1000 });
    });
  }
  stillWanted(item.id);
  // The deploy is the project's own command on its own checkout: it runs with the factory's environment, not the agent's.
  const r = await shell(p.deploy_command!, { cwd: dir, timeoutMs: 30 * 60 * 1000, env: p.env, signal, agent: false });
  stillWanted(item.id);
  const out = tail(`${r.stdout}\n${r.stderr}`.trim(), 6000);
  await emit({ itemId: item.id, type: "verify", level: r.code === 0 ? "info" : "error", message: `deploy ${r.code === 0 ? "finished" : r.timedOut ? "timed out" : `failed (${r.code})`} (${Math.round(r.durationMs / 1000)}s)`, data: { command: p.deploy_command, code: r.code, output: out } });
  if (r.code !== 0 || r.timedOut) throw new Error(`deploy ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}: ${out.slice(-800)}`);
  if (p.health_url) {
    let ok = false, last = "";
    for (let i = 0; i < 20 && !ok; i++) {
      try { const res = await fetch(p.health_url, { signal: AbortSignal.timeout(5000) }); ok = res.ok; last = `${res.status}`; } catch (e) { last = e instanceof Error ? e.message : String(e); }
      if (!ok) await new Promise((r2) => setTimeout(r2, 3000));
    }
    await emit({ itemId: item.id, type: "verify", level: ok ? "info" : "error", message: `health check ${ok ? "passed" : `failing (${last})`}: ${p.health_url}` });
    if (!ok) throw new Error(`deployed, but the health check at ${p.health_url} is failing (${last})`);
    // Then watch for a while: a deploy that answers once and falls over a minute later is not done.
    const minutes = p.limits.observeMinutes ?? 0;
    if (minutes > 0) {
      await setStatus(item.id, "deploying", { message: `deployed; watching ${p.health_url} for ${minutes} min` });
      const until = Date.now() + minutes * 60 * 1000;
      let failures = 0, checks = 0;
      while (Date.now() < until) {
        stillWanted(item.id);
        await new Promise((r2) => setTimeout(r2, 15000));
        checks++;
        try { const res = await fetch(p.health_url, { signal: AbortSignal.timeout(5000) }); if (!res.ok) { failures++; last = `${res.status}`; } } catch (e) { failures++; last = e instanceof Error ? e.message : String(e); }
        if (failures >= 2) break;
      }
      await emit({ itemId: item.id, type: "verify", level: failures >= 2 ? "error" : "info", message: failures >= 2 ? `health failed ${failures} of ${checks} checks after the deploy (${last})` : `healthy for ${minutes} min after the deploy (${checks} checks)` });
      if (failures >= 2) throw new Error(`deployed, but ${p.health_url} failed ${failures} of ${checks} checks in the ${minutes} minutes after (${last}); roll back by hand or retry`);
    }
  }
  await finish(await setStatus(item.id, "done", { message: "deployed" }), p, "done", "deployed");
}

// --- the end of a job -----------------------------------------------------------

async function finish(item: Item, p: Project, outcome: "done" | "failed" | "cancelled", why: string): Promise<void> {
  try {
    const last = await lastRun(item.id, ["build", "fix"]);
    const runner = getRunner(p.runner);
    if (runner.capabilities.structuredOutput && last) {
      const verifyEv = await q<{ data: { output?: string } }>("select data from events where item_id = $1 and type = 'verify' order by id desc limit 1", [item.id]);
      const existing = (await notesFor(p.id, 20)).map((n) => n.body);
      const prompt = notePrompt(forPrompt(item), p, `${outcome} (${why})`, last.result ?? "", tail(verifyEv[0]?.data?.output ?? "", 2000), existing);
      const { result } = await startRun(item, p, "learn", { cwd: item.worktree && fs.existsSync(item.worktree) ? item.worktree : repoDir(p), prompt, schema: NOTE_SCHEMA, tools: { mode: "none" }, maxTurns: 4, maxBudgetUsd: 0.5, timeoutMs: 5 * 60 * 1000 }, { small: true });
      const n = result.structured as { note?: string; tags?: string[] } | undefined;
      if (result.ok && n?.note && n.note.trim().length > 20) {
        await addNote({ projectId: p.id, itemId: item.id, author: runner.id, body: n.note, tags: n.tags ?? [] });
        await emit({ itemId: item.id, type: "note", message: `for the book: ${n.note}`, data: { tags: n.tags } });
      }
    }
  } catch (e) {
    if (!(e instanceof Cancelled)) log(item.id, null, `no note for the book: ${e instanceof Error ? e.message : String(e)}`, "warn");
  }
  const fresh = (await getItem(item.id))!;
  await postStatus(fresh, { text: outcome === "done" ? `#${fresh.id} "${fresh.title}" is done: ${why}.${fresh.pr_url ? ` ${fresh.pr_url}` : ""}` : `#${fresh.id} "${fresh.title}" ended as ${outcome}: ${why}`, level: outcome === "done" ? "success" : "warning", important: true });
  if (outcome !== "failed") await dropWorktree(fresh, p, { branch: true });
}

async function dropWorktree(item: Item, p: Project, opts: { branch?: boolean } = {}): Promise<void> {
  if (!item.worktree) return;
  try { await removeWorktree(repoDir(p), item.worktree); } catch (e) { log(item.id, null, `worktree not removed: ${e instanceof Error ? e.message : String(e)}`, "warn"); return; }
  await saveBranch(item.id, { worktree: null });
  // A merged or abandoned job's branch has nothing left to say; a failed one keeps its branch for a person to look at.
  if (opts.branch && item.branch) await git(["branch", "-D", item.branch], repoDir(p)).catch(() => {});
  log(item.id, null, `worktree removed${opts.branch ? ", branch deleted" : ""}`, "debug");
}

async function cleanupWorktrees(): Promise<void> {
  const s = await settings();
  const old = await q<Item>("select * from work_items where worktree is not null and status in ('done', 'cancelled', 'failed') and finished_at < now() - ($1 || ' days')::interval", [String(s.keepWorktreeDays)]);
  for (const it of old) { const p = await getProject(it.project_id); if (p) await dropWorktree(it, p); }
}

// --- people's levers --------------------------------------------------------------

export async function cancel(itemId: number, by: { name: string }): Promise<Item> {
  const item = await mustItem(itemId);
  if (["done", "cancelled", "failed"].includes(item.status)) return item;
  const slot = active.get(itemId);
  const it = await setStatus(itemId, "cancelled", { message: `cancelled by ${by.name}`, actor: by.name });
  const i = pending.findIndex((p) => p.itemId === itemId);
  if (i >= 0) pending.splice(i, 1);
  if (slot) {
    slot.ctrl.abort();
    for (let n = 0; n < 240 && active.has(itemId); n++) await new Promise((r) => setTimeout(r, 250));
  }
  const p = await getProject(item.project_id);
  if (p) await finish(it, p, "cancelled", `cancelled by ${by.name}`);
  return (await getItem(itemId))!;
}

export async function retry(itemId: number, by: { name: string }): Promise<Item> {
  const item = await mustItem(itemId);
  if (!["blocked", "failed", "cancelled", "needs_info"].includes(item.status)) throw new Error(`#${itemId} is ${item.status}; only blocked, failed, cancelled or waiting items can be retried`);
  await q("update work_items set fix_rounds = 0, verify_rounds = 0, error = null, paused = false where id = $1", [itemId]);
  const p = await mustProject(item.project_id);
  const stage = item.failed_stage;
  if ((stage === "merge" && item.worktree && fs.existsSync(item.worktree)) || stage === "deploy") {
    // The change is built (and for deploy, merged): pick up where it stopped instead of building it again. A merge goes back
    // through its gate, so a rejected merge cannot be forced through by a retry.
    const it = await setStatus(itemId, stage === "merge" ? "review" : "blocked", { message: `retried by ${by.name}: ${stage === "merge" ? "back to review and the merge gate" : "back to the deploy gate"}`, actor: by.name, force: true, failedStage: null });
    if (stage === "merge") void toMergeGate(it, p, by.name).catch((e) => fail(itemId, e));
    else void afterMerge(it, p).catch((e) => fail(itemId, e));
    return (await getItem(itemId))!;
  }
  const next = item.plan && item.status !== "needs_info" && stage !== "plan" ? "queued" : "inbox";
  const it = await setStatus(itemId, next, { message: `retried by ${by.name}`, actor: by.name, force: true, failedStage: null });
  setTimeout(() => tick().catch(() => {}), 10).unref();
  return it;
}

/** Skip the current gate or waiting state by hand: "just build it", "merge it", "deploy it". */
export async function nudge(itemId: number, action: "approve_gate" | "mark_done" | "skip_review", by: { userId?: number | null; name: string; via: string }): Promise<Item> {
  const item = await mustItem(itemId);
  if (action === "approve_gate") {
    const a = await pendingApproval(itemId);
    if (!a) throw new Error("nothing is waiting for approval");
    await decide(a.id, "approved", by);
  } else if (action === "skip_review") {
    if (item.status !== "review") throw new Error(`#${itemId} is ${item.status}, not in review`);
    await reviewDecision(itemId, "approved", `approved by ${by.name} without review`, by);
  } else {
    if (["done", "cancelled", "failed"].includes(item.status)) throw new Error(`#${itemId} is already ${item.status}`);
    if (isActive(itemId)) throw new Error(`#${itemId} has a run going; cancel it first, or wait`);
    const p = await mustProject(item.project_id);
    const it = await setStatus(itemId, "done", { message: `marked done by ${by.name}`, actor: by.name });
    await finish(it, p, "done", `marked done by ${by.name}`);
  }
  return (await getItem(itemId))!;
}
