// Five-field cron ("30 2 * * 1-5"): minute hour day-of-month month day-of-week.
// Supports *, lists, ranges and steps. Times are local to this machine.
export type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; raw: string };

function field(spec: string, min: number, max: number, names?: Record<string, number>): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part.trim());
    if (!m) throw new Error(`bad cron field "${part}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`bad step in "${part}"`);
    let lo = min, hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-");
      const num = (s: string) => { const n = names?.[s.toLowerCase()] ?? Number(s); if (!Number.isInteger(n)) throw new Error(`bad value "${s}" in cron`); return n; };
      lo = num(a); hi = b ? num(b) : m[2] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron value out of range in "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("a cron expression has five fields: minute hour day-of-month month day-of-week");
  const dow = field(parts[4], 0, 7, DAYS);
  if (dow.has(7)) dow.add(0);
  return { minute: field(parts[0], 0, 59), hour: field(parts[1], 0, 23), dom: field(parts[2], 1, 31), month: field(parts[3], 1, 12, MONTHS), dow, raw: expr.trim() };
}

export function matches(c: Cron, d: Date): boolean {
  return c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.dom.has(d.getDate()) && c.month.has(d.getMonth() + 1) && c.dow.has(d.getDay());
}

/** The next time (after `from`) the expression fires, within two years. */
export function next(c: Cron, from = new Date()): Date | null {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 2 * 366 * 24 * 60; i++) {
    if (matches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Has the expression fired between `last` (exclusive) and `now` (inclusive)? */
export function dueSince(c: Cron, last: Date | null, now = new Date()): boolean {
  const start = last ?? new Date(now.getTime() - 60 * 1000);
  const n = next(c, start);
  return Boolean(n && n.getTime() <= now.getTime());
}
