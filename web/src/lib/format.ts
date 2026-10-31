// How numbers, times and money read on screen.

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - new Date(iso).getTime();
  if (ms < 0) return inFuture(-ms);
  const m = Math.floor(ms / MIN);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(ms / HOUR);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(ms / DAY);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return fmtDate(iso, false);
}
function inFuture(ms: number): string {
  const m = Math.round(ms / MIN);
  if (m < 1) return "in a moment";
  if (m < 60) return `in ${m} min`;
  const h = Math.round(ms / HOUR);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(ms / DAY)} days`;
}
/** The compact age on a card: 4m, 3h, 2d. */
export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = Math.max(0, now - new Date(iso).getTime());
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MIN))}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

export function fmtDate(iso: string | null | undefined, time = true): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  return time ? `${date}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : date;
}
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function money(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 42 s · 4 min 12 s · 1 h 3 min */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ""}`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
/** Hours as the most readable unit: 25 min · 3.4 h · 2.1 d */
export function fmtHours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${(h / 24).toFixed(1)} d`;
}
export const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${Math.round(x * 100)}%`);
export const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const short = (s: string | null | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const shortSha = (s: string | null | undefined) => (s ? s.slice(0, 7) : "");

/** "a, b , c" → ["a","b","c"] */
export const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
/** One per line, blank lines dropped. */
export const splitLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
