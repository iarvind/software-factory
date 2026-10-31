// The shapes the server sends, mirrored from server/lib/*.ts and server/routes/*.ts.

export type Role = "admin" | "member" | "viewer" | "pending";
export type SessionUser = { id: number; email: string; name: string | null; picture: string | null; role: Role;
  /** The role meets the approverRole setting: may open gates and review. */
  canApprove?: boolean };
export type SessionInfo = { ok: boolean; user: SessionUser | null; methods: { google: boolean; dev: boolean }; proxied: boolean; approverRole?: "member" | "admin" };

export const STATUSES = ["inbox", "planning", "needs_info", "awaiting_approval", "queued", "building", "verifying", "reviewing", "review", "fixing", "merging", "deploying", "done", "failed", "cancelled", "blocked"] as const;
export type Status = (typeof STATUSES)[number];
export type Gate = "plan" | "merge" | "deploy";
export type Origin = { kind: string; [k: string]: unknown };

export type Plan = {
  summary: string; kind: string; size: string; risk: "low" | "medium" | "high"; clarity: "clear" | "needs_info";
  questions: string[]; steps: string[]; files: string[]; tests: string[]; risks: string[]; acceptance: string[]; estimate_minutes: number;
};

export type Item = {
  id: number; project_id: number | null; source_id: number | null; external_id: string | null; external_url: string | null; origin: Origin;
  title: string; body: string; kind: string | null; size: string | null; risk: string | null; priority: number; status: Status; gate: Gate | null;
  plan: Plan | null; branch: string | null; worktree: string | null; base_sha: string | null; head_sha: string | null; pr_url: string | null; pr_number: number | null;
  /** The stage a blocked or failed item stopped in ("plan", "build", "merge", "deploy"); a retry resumes from it. */
  failed_stage: string | null;
  requester_id: number | null; requester_name: string | null; assignee_id: number | null; labels: string[];
  cost_usd: number; turns: number; fix_rounds: number; verify_rounds: number; error: string | null; paused: boolean;
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null; due_at: string | null;
};

export type Approval = { id: number; item_id: number; kind: Gate | "info"; status: "pending" | "approved" | "rejected" | "expired"; summary: string | null; payload: unknown; requested_at: string; decided_at: string | null; decided_by: number | null; decided_via: string | null; note: string | null };
export type PendingApproval = Approval & { title: string; project_id: number | null };
export type Feedback = { id: number; item_id: number; run_id: number | null; source: string; author: string | null; body: string; kind: "comment" | "changes_requested" | "approved" | "answer"; external_id: string | null; handled_at: string | null; created_at: string };
export type Post = { id: number; target: string; ref: unknown; body: string | null; ok: boolean; error: string | null; created_at: string };
export type Run = {
  id: number; item_id: number; kind: string; runner: string; model: string | null; effort: string | null; session_id: string | null; status: string; worktree: string | null; branch: string | null;
  prompt?: string | null; result: string | null; structured: unknown; cost_usd: number | null; turns: number | null; usage: unknown; exit_code: number | null; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
};

export type EventType = "status" | "log" | "text" | "tool" | "tool_result" | "note" | "error" | "approval" | "feedback" | "post" | "run" | "verify" | "git" | "system";
export type Level = "debug" | "info" | "warn" | "error";
export type Ev = { id: number; item_id: number | null; run_id: number | null; type: EventType; level: Level; message: string | null; data: unknown; actor: string | null; at: string };

export type ActiveRun = { itemId: number; runId: number | null; kind: string; projectId: number | null; startedAt: string };
export type Usage = { fiveHour?: number; sevenDay?: number; resetsAt?: number; status?: string; at: string };
export type BoardProject = { id: number; slug: string; name: string; paused: boolean; delivery: "pr" | "local" };
export type BoardData = { items: Item[]; projects: BoardProject[]; active: ActiveRun[]; paused: boolean; held: string | null; usage: Record<string, Usage>; statuses: Status[] };

export type GatePolicy = "manual" | "auto" | "auto_low_risk";
export type Gates = { plan: GatePolicy; merge: GatePolicy; deploy: "manual" | "auto" | "off"; review: "ai" | "off" };
export type Limits = { maxTurns: number; maxBudgetUsd: number; maxMinutes: number; maxFixRounds: number; concurrency: number; verifyMinutes: number; maxInReview: number;
  /** Minutes to watch health_url after a deploy; two failed checks block the item. */
  observeMinutes: number };
export type Tools = { mode: "readonly" | "edit" | "full"; allow: string[]; deny: string[] };

export type ItemDetail = {
  item: Item; runs: Run[]; approvals: Approval[]; feedback: Feedback[]; posts: Post[];
  project: { id: number; slug: string; name: string; delivery: "pr" | "local"; default_branch: string; gates: Gates } | null;
  active: boolean; pending: Approval | null;
};

export type Project = {
  id: number; slug: string; name: string; description: string | null; repo_url: string | null; local_path: string | null; default_branch: string;
  runner: string | null; model: string | null; effort: string | null; setup_command: string | null; test_command: string | null; build_command: string | null; deploy_command: string | null; health_url: string | null;
  delivery: "pr" | "local"; gates: Gates; limits: Limits; tools: Tools;
  /** Only the names: values never leave the server. */
  env: string[];
  instructions: string | null; paused: boolean; created_by: number | null; created_at: string; updated_at: string;
  open?: number; done?: number;
};
export type Capabilities = { resume: boolean; structuredOutput: boolean; tools: boolean; costReporting: boolean; budget: boolean };
export type ProjectDefaults = { gates: Gates; limits: Limits; tools: Tools; runners: Array<{ id: string; label: string; capabilities: Capabilities }>; defaultRunner: string; defaultModel: string };
/** What GET /api/projects/discover guessed from a checkout's files; every field is editable before it is added. */
export type Suggestions = { test_command: string | null; build_command: string | null; deploy_command: string | null; setup_command: string | null; health_url: string | null; instructions: string | null };
export type Candidate = { path: string; name: string; slug: string; default_branch: string; remote: string | null; github: string | null; suggestions: Suggestions };
export type Discovery = { roots: string[]; candidates: Candidate[] };
export type ProjectCheck = Record<string, unknown> & { ok?: boolean; error?: string; dir?: string };
export type Note = { id: number; project_id: number | null; item_id: number | null; author: string; body: string; tags: string[]; created_at: string };

export type Field = { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string; kind?: "text" | "textarea" | "number" | "select" | "boolean"; options?: string[]; default?: unknown };
export type SourceKind = { kind: string; label: string; description: string;
  /** Setup steps for the outside service (the Slack kind carries its whole app manifest); copy it verbatim. */
  help: string | null;
  fields: Field[]; defaultIntervalSec: number | null; longLived: boolean; polls: boolean; webhook: boolean };
export type SourceKinds = { kinds: SourceKind[]; encryption: boolean };
export type Source = {
  id: number; project_id: number | null; kind: string; name: string; config: Record<string, unknown>; enabled: boolean;
  interval_sec: number | null; cron: string | null; cursor: Record<string, unknown>; state: Record<string, unknown>;
  last_polled_at: string | null; last_ok_at: string | null; last_error: string | null; created_by: number | null; created_at: string; updated_at: string;
  /** Masked: "••••••abcd". */
  secrets: Record<string, string>; live: string | null;
  adapter: { label: string; polls: boolean; longLived: boolean; webhook: boolean } | null;
};

export type UserRow = { id: number; email: string; name: string | null; picture: string | null; role: Role; created_at: string; last_seen_at: string | null; disabled: boolean; items: number; me: boolean };

export type Metrics = {
  days: number;
  byStatus: Array<{ status: string; n: number }>;
  totals: { created: number; done: number; failed: number; cancelled: number; cost: number; turns: number } | null;
  lead: { median_h: number | null; p90_h: number | null; mean_h: number | null } | null;
  rounds: { fix: number | null; verify: number | null; cost_per_done: number | null; first_pass: number | null } | null;
  waiting: { approvals: number; review: number; needs_info: number; blocked: number; oldest_wait_h: number | null } | null;
  byDay: Array<{ day: string; created: number; done: number; failed: number; cost: number }>;
  byProject: Array<{ project_id: number; name: string; open: number; done: number; failed: number; cost: number; median_h: number | null }>;
  bySource: Array<{ kind: string; n: number; done: number }>;
  stages: Array<{ status: string; hours: number }>;
  runs: Array<{ kind: string; n: number; ok: number; cost: number; avg_min: number | null; turns: number | null }>;
};

export type Settings = { paused: boolean; maxConcurrentRuns: number; approverRole: "member" | "admin"; keepWorktreeDays: number; newAccountRole: "pending" | "viewer"; usageThreshold: number;
  /** API-equivalent USD a day before new runs are held; 0 is no cap. */
  dailyBudgetUsd: number;
  /** Local hour of the daily digest; -1 is off. */
  digestHour: number };
/** Runs finished since midnight, as the CLI reported their cost. */
export type Spend = { today: { total: number; byProject: Array<{ project_id: number; name: string; usd: number }> }; dailyBudgetUsd: number };
export type RunnerCheck = { id: string; label: string; capabilities: Capabilities; ok: boolean; version?: string; detail?: string };
export type NotifierStatus = { configured: boolean; reachable: boolean; channels: number; hook: unknown; url: string | null; error?: string };
export type SettingsData = {
  settings: Settings; spend: Spend; runners: RunnerCheck[]; usage: Record<string, Usage>; held: string | null; notifier: NotifierStatus;
  encryption: boolean; google: boolean; defaultRunner: string; model: string; smallModel: string; dataDir: string;
};
/** GET /api/status: one screen of truth for the CLI and chat commands. */
export type StatusData = {
  paused: boolean; held: string | null; active: ActiveRun[]; counts: Array<{ status: string; n: number }>; today: { done: number; created: number } | null;
  waiting: Array<{ id: number; title: string; status: string; gate: string | null; updated_at: string }>; usage: Record<string, Usage>; spend: Spend;
};
export type DeviceSession = { id: number; device: string; ip: string | null; created_at: string; last_seen_at: string; expires_at: string; current: boolean };
export type ApiToken = { id: number; name: string; prefix: string; created_at: string; last_used_at: string | null };
