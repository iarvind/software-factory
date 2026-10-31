// Factory-wide switches, kept in kv so an admin can flip them from the UI without a restart.
import { kvGet, kvSet } from "../db.ts";

export type Settings = {
  /** The kill switch: nothing new starts while true; running jobs finish their current step. */
  paused: boolean;
  maxConcurrentRuns: number;
  /** Who may approve gates: members or only admins. */
  approverRole: "member" | "admin";
  /** Days to keep worktrees of finished jobs before they are removed. */
  keepWorktreeDays: number;
  /** New accounts not matched by .env: pending (wait for an admin) or viewer (see everything, change nothing). */
  newAccountRole: "pending" | "viewer";
  /** Hold new runs when a runner's five-hour plan window is used beyond this fraction. */
  usageThreshold: number;
  /** Hold new runs once today's runs have cost this much (API-equivalent USD, as the CLI reports it); 0 is no cap. */
  dailyBudgetUsd: number;
  /** Local hour of the daily digest to Telegram and status channels; -1 turns it off. */
  digestHour: number;
};

const DEFAULTS: Settings = { paused: false, maxConcurrentRuns: Number(process.env.MAX_CONCURRENT_RUNS || 2), approverRole: "member", keepWorktreeDays: 3, newAccountRole: "pending", usageThreshold: 0.9, dailyBudgetUsd: 0, digestHour: 9 };
let cache: { s: Settings; until: number } | null = null;

export async function settings(): Promise<Settings> {
  if (cache && cache.until > Date.now()) return cache.s;
  const stored = (await kvGet<Partial<Settings>>("settings")) ?? {};
  const s = { ...DEFAULTS, ...stored };
  cache = { s, until: Date.now() + 5000 };
  return s;
}
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const s = { ...(await settings()), ...patch };
  await kvSet("settings", s);
  cache = { s, until: Date.now() + 5000 };
  return s;
}
