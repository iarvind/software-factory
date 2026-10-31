// Inline SVG charts, drawn at the container's real pixel width so text never scales.
// Thin marks, 2px lines, 4px rounded data-ends on a single baseline, recessive axes,
// a hover layer on every plot, and a table view for every chart.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => { const r = entries[0]?.contentRect; if (r) setW(Math.floor(r.width)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Round ticks from zero: 0, 2, 4, 6 — or 0, 0.5, 1 for small money. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** A rounded data-end on a bar that grows up from the baseline. */
function colPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}
/** The same for a bar that grows right from a left baseline. */
function rowPath(x: number, y: number, w: number, h: number, r = 4) {
  if (w <= 0) return "";
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

type TipLine = { label: string; value: string; cls?: string };
/** A tooltip drawn inside the SVG, flipped to stay on the plot. */
function Tip({ x, y, title, lines, width }: { x: number; y: number; title: string; lines: TipLine[]; width: number }) {
  const w = Math.max(title.length, ...lines.map((l) => l.label.length + l.value.length + 2)) * 6.6 + 34;
  const h = 22 + lines.length * 18;
  const tx = x + 12 + w > width ? x - 12 - w : x + 12;
  const ty = Math.max(2, y - h / 2);
  return (
    <g className="tip" transform={`translate(${tx},${ty})`} pointerEvents="none">
      <rect width={w} height={h} rx="8" />
      <text x="10" y="16" className="tip-title">{title}</text>
      {lines.map((l, i) => (
        <g key={i} transform={`translate(10,${22 + i * 18})`}>
          {l.cls && <rect className={`swatch ${l.cls}`} y="4" width="10" height="3" rx="1.5" />}
          <text x={l.cls ? 16 : 0} y="10" className="tip-label">{l.label}</text>
          <text x={w - 20} y="10" className="tip-value" textAnchor="end">{l.value}</text>
        </g>
      ))}
    </g>
  );
}

export function Legend({ items }: { items: Array<{ label: string; cls: string }> }) {
  return <div className="legend">{items.map((i) => <span key={i.label} className="legend-item"><svg width="14" height="4" aria-hidden="true"><rect className={`swatch ${i.cls}`} width="14" height="4" rx="2" /></svg>{i.label}</span>)}</div>;
}

export function ChartFrame({ title, hint, legend, table, children }: { title: string; hint?: ReactNode; legend?: ReactNode; table: ReactNode; children: ReactNode }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <div><div className="chart-title">{title}</div>{hint && <div className="chart-hint">{hint}</div>}</div>
        <button type="button" className="btn ghost sm" aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>{showTable ? "Show chart" : "Show table"}</button>
      </figcaption>
      {!showTable && legend}
      {showTable ? <div className="table-wrap">{table}</div> : children}
    </figure>
  );
}

export type Series = { key: string; label: string; cls: string; values: number[] };

export function LineChart({ days, series, height = 220, fmt = (n: number) => String(n), label }: { days: string[]; series: Series[]; height?: number; fmt?: (n: number) => string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { l: 34, r: 76, t: 10, b: 26 };
  const iw = Math.max(10, width - m.l - m.r), ih = height - m.t - m.b;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const n = days.length;
  const x = (i: number) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => m.t + ih - (v / top) * ih;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
  const pick = (clientX: number, el: SVGElement) => {
    const r = el.getBoundingClientRect();
    const i = n <= 1 ? 0 : Math.round(((clientX - r.left - m.l) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const ends = series.map((s) => ({ s, v: s.values[n - 1] ?? 0 }));
  const endsApart = ends.length < 2 || ends.every((a, i) => ends.every((b, j) => i === j || Math.abs(y(a.v) - y(b.v)) >= 16));
  return (
    <div ref={ref} className="plot">
      {width > 0 && n > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} tabIndex={0}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget)} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
          onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); setHover((h) => Math.max(0, Math.min(n - 1, (h ?? n - 1) + (e.key === "ArrowRight" ? 1 : -1)))); } }}>
          {ticks.map((t) => <g key={t}><line className="grid" x1={m.l} x2={m.l + iw} y1={y(t)} y2={y(t)} /><text className="tick" x={m.l - 8} y={y(t) + 4} textAnchor="end">{fmt(t)}</text></g>)}
          <line className="axis" x1={m.l} x2={m.l + iw} y1={y(0)} y2={y(0)} />
          {days.map((d, i) => (i % every === 0 || i === n - 1) && (i === n - 1 || x(n - 1) - x(i) >= 72) ? <text key={d} className="tick" x={x(i)} y={height - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>{dayLabel(d)}</text> : null)}
          {series.map((s) => (
            <g key={s.key}>
              <path className={`area ${s.cls}`} d={`M${x(0)},${y(0)}${s.values.map((v, i) => `L${x(i)},${y(v)}`).join("")}L${x(n - 1)},${y(0)}Z`} />
              <path className={`line ${s.cls}`} d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("")} />
              <circle className={`dot ${s.cls}`} cx={x(n - 1)} cy={y(s.values[n - 1] ?? 0)} r="4" />
              {endsApart && <text className="end-label" x={x(n - 1) + 10} y={y(s.values[n - 1] ?? 0) + 4}>{fmt(s.values[n - 1] ?? 0)} {s.label.toLowerCase()}</text>}
            </g>
          ))}
          {hover != null && (
            <g pointerEvents="none">
              <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} />
              {series.map((s) => <circle key={s.key} className={`dot ${s.cls}`} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r="4" />)}
              <Tip x={x(hover)} y={m.t + ih / 3} width={width} title={dayLabel(days[hover])} lines={series.map((s) => ({ label: s.label, value: fmt(s.values[hover] ?? 0), cls: s.cls }))} />
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

export function ColumnChart({ days, values, cls, height = 180, fmt = (n: number) => String(n), label, name }: { days: string[]; values: number[]; cls: string; height?: number; fmt?: (n: number) => string; label: string; name: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { l: 44, r: 8, t: 10, b: 26 };
  const iw = Math.max(10, width - m.l - m.r), ih = height - m.t - m.b;
  const ticks = niceTicks(Math.max(0, ...values));
  const top = ticks[ticks.length - 1] || 1;
  const n = values.length;
  const band = iw / Math.max(1, n);
  const bw = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => m.t + ih - (v / top) * ih;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
  return (
    <div ref={ref} className="plot">
      {width > 0 && n > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} tabIndex={0}
          onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left - m.l) / band); setHover(i >= 0 && i < n ? i : null); }}
          onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
          onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); setHover((h) => Math.max(0, Math.min(n - 1, (h ?? n - 1) + (e.key === "ArrowRight" ? 1 : -1)))); } }}>
          {ticks.map((t) => <g key={t}><line className="grid" x1={m.l} x2={m.l + iw} y1={y(t)} y2={y(t)} /><text className="tick" x={m.l - 8} y={y(t) + 4} textAnchor="end">{fmt(t)}</text></g>)}
          {values.map((v, i) => <path key={i} className={`bar ${cls} ${hover === i ? "on" : ""}`} d={colPath(m.l + i * band + (band - bw) / 2, y(v), bw, y(0) - y(v))} />)}
          <line className="axis" x1={m.l} x2={m.l + iw} y1={y(0)} y2={y(0)} />
          {days.map((d, i) => (i % every === 0 && (n - 1 - i) * band >= 72) || i === n - 1 ? <text key={d} className="tick" x={i === n - 1 ? m.l + iw : m.l + i * band + band / 2} y={height - 8} textAnchor={i === n - 1 ? "end" : "middle"}>{dayLabel(d)}</text> : null)}
          {hover != null && <Tip x={m.l + hover * band + band / 2} y={Math.min(y(values[hover]), m.t + ih / 2)} width={width} title={dayLabel(days[hover])} lines={[{ label: name, value: fmt(values[hover]) }]} />}
        </svg>
      )}
    </div>
  );
}

export function BarList({ rows, fmt = (n: number) => String(n), label }: { rows: Array<{ key: string; label: string; value: number; cls: string }>; fmt?: (n: number) => string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const lw = Math.min(140, Math.max(90, width * 0.28)), vw = 64, rh = 30, bh = 12;
  const iw = Math.max(10, width - lw - vw);
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  const height = rows.length * rh + 4;
  return (
    <div ref={ref} className="plot">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          <line className="axis" x1={lw} x2={lw} y1={0} y2={height} />
          {rows.map((r, i) => {
            const w = (r.value / max) * iw;
            return (
              <g key={r.key} transform={`translate(0,${i * rh})`} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <rect className="hit" x={0} y={0} width={width} height={rh} />
                <text className="row-label" x={lw - 10} y={rh / 2 + 4} textAnchor="end">{r.label}</text>
                <path className={`bar ${r.cls} ${hover === i ? "on" : ""}`} d={rowPath(lw, (rh - bh) / 2, Math.max(r.value > 0 ? 2 : 0, w), bh)} />
                <text className="row-value" x={lw + Math.max(2, w) + 8} y={rh / 2 + 4}>{fmt(r.value)}</text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** A thin meter: fill carries severity, the track is the same hue lighter; the number is printed beside it. */
export function Meter({ value, warnAt = 0.7, badAt = 0.9, label }: { value: number; warnAt?: number; badAt?: number; label: string }) {
  const v = Math.max(0, Math.min(1, value));
  const tone = v >= badAt ? "bad" : v >= warnAt ? "wait" : "work";
  return (
    <svg className={`meter f-${tone}`} viewBox="0 0 100 8" preserveAspectRatio="none" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <rect className="meter-track" width="100" height="8" />
      <rect className="meter-fill" width={v * 100} height="8" />
    </svg>
  );
}
