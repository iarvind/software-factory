// Status is the one thing on screen that carries colour. Each status belongs to a family,
// and each family has one hue: waiting on a person (amber), working (blue), in review
// (violet), done (green), stopped (red), and idle (grey).
import type { Item, Status } from "./types";

export type Family = "wait" | "work" | "review" | "done" | "bad" | "idle";

export const STATUS: Record<Status, { label: string; family: Family; hint: string }> = {
  inbox: { label: "Inbox", family: "idle", hint: "arrived, not planned yet" },
  planning: { label: "Planning", family: "work", hint: "an agent is reading the request and the code" },
  needs_info: { label: "Needs info", family: "wait", hint: "waiting for the requester to answer" },
  awaiting_approval: { label: "Awaiting approval", family: "wait", hint: "waiting for someone to open a gate" },
  queued: { label: "Queued", family: "work", hint: "approved, waiting for a build slot" },
  building: { label: "Building", family: "work", hint: "an agent is making the change" },
  verifying: { label: "Verifying", family: "work", hint: "running the project's tests and build" },
  reviewing: { label: "AI review", family: "work", hint: "a second agent is reviewing the change" },
  review: { label: "In review", family: "review", hint: "waiting for a person to review the change" },
  fixing: { label: "Fixing", family: "work", hint: "addressing review feedback" },
  merging: { label: "Merging", family: "work", hint: "merging into the default branch" },
  deploying: { label: "Deploying", family: "work", hint: "running the deploy and the health check" },
  done: { label: "Done", family: "done", hint: "shipped" },
  failed: { label: "Failed", family: "bad", hint: "stopped with an error" },
  cancelled: { label: "Cancelled", family: "idle", hint: "stopped by a person" },
  blocked: { label: "Blocked", family: "bad", hint: "parked until someone retries or cancels it" },
};
export const statusLabel = (s: string) => STATUS[s as Status]?.label ?? s.replace(/_/g, " ");
export const familyOf = (s: string): Family => STATUS[s as Status]?.family ?? "idle";

export const ACTIVE: Status[] = ["planning", "building", "verifying", "reviewing", "fixing", "merging", "deploying"];
export const CLOSED: Status[] = ["done", "failed", "cancelled"];
export const isActive = (s: Status) => ACTIVE.includes(s);

/** "stopped during merge" for a blocked or failed item that knows where it stopped. */
export const stoppedAt = (i: Pick<Item, "status" | "failed_stage">): string | null =>
  i.failed_stage && (i.status === "blocked" || i.status === "failed") ? `stopped during ${i.failed_stage}` : null;

/** Where Retry picks the item up; mirrors retry() in server/lib/pipeline.ts. */
export function retryLabel(i: Pick<Item, "status" | "failed_stage" | "plan">): string {
  if (i.failed_stage === "merge") return "Retry: back to the merge gate";
  if (i.failed_stage === "deploy") return "Retry: back to the deploy gate";
  return i.plan && i.status !== "needs_info" && i.failed_stage !== "plan" ? "Retry: build again" : "Retry: plan again";
}

/** The request's title, text and project can change only until the plan is accepted; mirrors PATCH /api/items/:id. */
export const requestEditable = (i: Pick<Item, "status" | "gate">) =>
  (["inbox", "needs_info", "awaiting_approval", "blocked", "failed", "cancelled"] as Status[]).includes(i.status) && (i.status !== "awaiting_approval" || i.gate === "plan");

export type Column = { key: string; label: string; family: Family; statuses: Status[]; hint: string };
export const COLUMNS: Column[] = [
  { key: "inbox", label: "Inbox", family: "idle", statuses: ["inbox", "needs_info"], hint: "New, or waiting for an answer" },
  { key: "planning", label: "Planning", family: "work", statuses: ["planning"], hint: "Reading the request and the code" },
  { key: "approval", label: "Approval", family: "wait", statuses: ["awaiting_approval"], hint: "A gate is waiting for someone" },
  { key: "queued", label: "Queued", family: "work", statuses: ["queued"], hint: "Waiting for a build slot" },
  { key: "working", label: "Working", family: "work", statuses: ["building", "verifying", "reviewing", "fixing", "merging", "deploying"], hint: "Agents at work" },
  { key: "review", label: "Review", family: "review", statuses: ["review"], hint: "Waiting for a person's review" },
  { key: "blocked", label: "Blocked", family: "bad", statuses: ["blocked", "failed"], hint: "Stopped; retry or cancel" },
  { key: "done", label: "Done", family: "done", statuses: ["done", "cancelled"], hint: "Finished in the last three days" },
];

export const GATE_LABEL: Record<string, string> = { plan: "Plan", merge: "Merge", deploy: "Deploy", info: "Info" };
export const PRIORITY: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Normal", 4: "Low", 5: "Someday" };

export const ORIGIN_LABEL: Record<string, string> = {
  manual: "Form", api: "API", slack: "Slack", jira: "Jira", github: "GitHub", linear: "Linear", schedule: "Schedule", watch: "Service watch", webhook: "Webhook", telegram: "Telegram",
};
