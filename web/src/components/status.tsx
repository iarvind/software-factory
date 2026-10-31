import { familyOf, statusLabel, GATE_LABEL, PRIORITY, ORIGIN_LABEL, type Family } from "../lib/status";
import type { Origin } from "../lib/types";
import { Icon } from "./icons";

export function Lamp({ family, live, label }: { family: Family; live?: boolean; label?: string }) {
  return <span className={`lamp f-${family} ${live ? "live" : ""}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function StatusPill({ status, gate, live }: { status: string; gate?: string | null; live?: boolean }) {
  const f = familyOf(status);
  return (
    <span className={`pill st f-${f}`}>
      {live ? <span className="spin sm" aria-hidden="true" /> : <span className="lamp" aria-hidden="true" />}
      {statusLabel(status)}{gate && status === "awaiting_approval" ? `: ${GATE_LABEL[gate] ?? gate}` : ""}
    </span>
  );
}

/** Three bars, filled from the left by urgency; drawn in ink, since only status gets colour. */
export function PriorityMark({ p }: { p: number }) {
  const filled = Math.max(0, 4 - p);
  const label = `Priority ${p}: ${PRIORITY[p] ?? ""}`;
  return (
    <svg className={`prio p${p}`} width="14" height="12" viewBox="0 0 14 12" role="img" aria-label={label}>
      <title>{label}</title>
      {[0, 1, 2].map((i) => <rect key={i} x={i * 5} y={8 - i * 3} width="3.4" height={4 + i * 3} rx="1" className={i < filled ? "on" : ""} />)}
    </svg>
  );
}

export function OriginIcon({ origin }: { origin: Origin | null | undefined }) {
  const kind = origin?.kind ?? "manual";
  return <span className="origin"><Icon name={kind} label={`From ${ORIGIN_LABEL[kind] ?? kind}`} /></span>;
}
