import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ago, fmtDate } from "../lib/format";
import { useNow } from "../lib/clock";

// ---------- page structure ----------
export function Page({ title, subtitle, aside, children, wide }: { title: ReactNode; subtitle?: ReactNode; aside?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`page ${wide ? "wide" : ""}`}>
      <header className="page-head">
        <h1 className="page-title">{title}</h1>
        {aside && <div className="page-aside">{aside}</div>}
        {subtitle && <div className="page-sub">{subtitle}</div>}
      </header>
      {children}
    </div>
  );
}

export function Section({ title, hint, aside, children, first, id }: { title?: ReactNode; hint?: ReactNode; aside?: ReactNode; children: ReactNode; first?: boolean; id?: string }) {
  return (
    <section className={`section ${first ? "first" : ""}`} id={id}>
      {(title || aside) && (
        <div className="section-head">
          <div className="inline"><h2 className="section-title">{title}</h2>{hint && <span className="section-hint">{hint}</span>}</div>
          {aside && <div className="inline">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`group ${className ?? ""}`}>{children}</div>;
}

export function Row({ title, subtitle, leading, trailing, to, onClick, className, block }: {
  title?: ReactNode; subtitle?: ReactNode; leading?: ReactNode; trailing?: ReactNode; to?: string; onClick?: () => void; className?: string; block?: ReactNode;
}) {
  const inner = (
    <>
      {leading}
      <div className="row-main">
        {title != null && <div className="row-title">{title}</div>}
        {subtitle != null && subtitle !== "" && <div className="row-sub">{subtitle}</div>}
        {block}
      </div>
      {trailing != null && <div className="row-trailing">{trailing}</div>}
    </>
  );
  if (to) return <Link to={to} className={`row clickable ${className ?? ""}`}>{inner}{<span className="chevron" aria-hidden="true">›</span>}</Link>;
  if (onClick) return <div role="button" tabIndex={0} className={`row clickable ${className ?? ""}`} onClick={onClick} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick(); } }}>{inner}</div>;
  return <div className={`row ${className ?? ""}`}>{inner}</div>;
}

export function Empty({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{hint && <span>{hint}</span>}{action}</div>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <div className="loading" role="status"><Spinner />{label}</div>;
}
export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <div className="banner bad" role="alert"><span className="grow">{error}</span>{onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>}</div>;
}
/** A refresh failed while older data stays on screen; it goes away when the next one succeeds. */
export function RefreshError({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return <p className="refresh-error" role="status"><span>Could not refresh: {error}</span>{onRetry && <Button size="sm" variant="ghost" onClick={onRetry}>Try again</Button>}</p>;
}
export function Banner({ tone = "info", children, action }: { tone?: "info" | "wait" | "bad" | "done"; children: ReactNode; action?: ReactNode }) {
  return <div className={`banner ${tone}`} role={tone === "bad" ? "alert" : undefined}><span className="grow">{children}</span>{action}</div>;
}

// ---------- controls ----------
type BtnProps = { variant?: "primary" | "secondary" | "ghost" | "danger" | "quiet"; size?: "sm"; block?: boolean };
export function Button({ variant = "primary", size, block, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & BtnProps & { ref?: React.Ref<HTMLButtonElement> }) {
  return <button type="button" {...props} className={`btn ${variant} ${size ?? ""} ${block ? "block" : ""} ${className ?? ""}`} />;
}
export function ButtonLink({ to, variant = "secondary", size, children, className }: { to: string; children: ReactNode; className?: string } & BtnProps) {
  return <Link to={to} className={`btn ${variant} ${size ?? ""} ${className ?? ""}`}>{children}</Link>;
}

/** A labelled control. With `group`, the label names a set of controls (segmented buttons) instead of wrapping one. */
export function Field({ label, hint, children, required, className, group }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; required?: boolean; className?: string; group?: boolean }) {
  const id = useId();
  if (group) {
    return (
      <div className={`field ${className ?? ""}`} role="group" aria-labelledby={label ? id : undefined}>
        {label && <span className="field-label" id={id}>{label}</span>}
        {children}
        {hint && <span className="field-hint">{hint}</span>}
      </div>
    );
  }
  return (
    <label className={`field ${className ?? ""}`}>
      {label && <span className="field-label">{label}{required && <span className="req" aria-label="required"> *</span>}</span>}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={`input ${props.className ?? ""}`} />; }
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className={`select ${props.className ?? ""}`} />; }
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} className={`textarea ${props.className ?? ""}`} />; }

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} />;
}

/** Underlined tabs; the panel is whatever the caller renders for the selected value, as
 *  `<div role="tabpanel" id={panelId} aria-labelledby={tabId(panelId, value)}>`. Arrow keys, Home and End move between tabs. */
export const tabId = (panelId: string, value: string) => `${panelId}-tab-${value}`;
export function Tabs<T extends string>({ value, options, onChange, label, panelId }: { value: T; options: Array<{ value: T; label: ReactNode; count?: number }>; onChange: (v: T) => void; label: string; panelId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    const i = options.findIndex((o) => o.value === value);
    const to = e.key === "ArrowRight" ? (i + 1) % options.length : e.key === "ArrowLeft" ? (i - 1 + options.length) % options.length
      : e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(options[to].value);
    ref.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[to]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={ref} onKeyDown={onKey}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="tab" id={tabId(panelId, o.value)} aria-selected={on} aria-controls={panelId} tabIndex={on ? 0 : -1} className={on ? "on" : ""} onClick={() => onChange(o.value)}>
            {o.label}{o.count ? <span className="tab-count num">{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A button that opens a short list of actions. Closes on choice, Escape, or a click elsewhere;
 *  a choice or Escape puts focus back on the button. Up and Down move through the items. */
export function Menu({ label, items, variant = "secondary", size }: { label: ReactNode; items: Array<{ label: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }>; variant?: BtnProps["variant"]; size?: "sm" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];
      if (!list.length) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length].focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])")?.focus();
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <Button ref={btn} variant={variant} size={size} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{label}<Caret /></Button>
      {open && (
        <div className="menu-list" role="menu" id={id}>
          {items.map((it, i) => (
            // Focus goes back to the button first, so a sheet the choice opens returns focus there when it closes.
            <button key={i} type="button" role="menuitem" disabled={it.disabled} className={it.danger ? "danger" : ""} onClick={() => { setOpen(false); btn.current?.focus(); it.onSelect(); }}>
              <span>{it.label}</span>{it.hint && <small>{it.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const Caret = () => <svg className="caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" variant="secondary" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1600); }
      catch { toast("Copying is blocked here; select the text and copy it by hand.", true); }
    }}>{done ? "Copied" : label}</Button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spin" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

/** "4 min ago", kept current, with the exact time on hover. */
export function Ago({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const now = useNow();
  if (!iso) return null;
  return <time className={className} dateTime={iso} title={fmtDate(iso)}>{ago(iso, now)}</time>;
}

export function Avatar({ name, picture, size = 28 }: { name: string; picture?: string | null; size?: 20 | 28 | 36 }) {
  const [broken, setBroken] = useState(false);
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join("");
  if (picture && !broken) return <img className={`avatar s${size}`} src={picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  return <span className={`avatar s${size}`} aria-hidden="true">{initials || "?"}</span>;
}

/** Plain text with its line breaks kept and URLs made into links. */
export function Linkify({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return (
    <div className={`plain ${className ?? ""}`}>
      {parts.map((p, i) => (i % 2 === 1 ? <a key={i} href={p} target="_blank" rel="noreferrer noopener">{p}</a> : p))}
    </div>
  );
}

// ---------- sheet ----------
const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";
/** A modal panel. Focus moves in when it opens, Tab and Shift+Tab stay inside, Escape closes it,
 *  and focus goes back to whatever opened it. */
export function Sheet({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Callers pass inline arrows; keyed on them, the effect would re-run (and re-focus) on every parent render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      const box = ref.current;
      if (e.key === "Escape") { close.current(); return; }
      if (e.key !== "Tab" || !box) return;
      const list = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && !el.closest("fieldset:disabled"));
      if (!list.length) { e.preventDefault(); box.focus(); return; }
      const first = list[0], last = list[list.length - 1];
      const at = document.activeElement;
      if (!box.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && (at === first || at === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("locked");
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, select, [data-autofocus]");
    (first ?? ref.current)?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("locked");
      if (prev?.isConnected) prev.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="sheet-head"><h2 className="sheet-title" id={titleId}>{title}</h2><button type="button" className="iconbtn" onClick={onClose} aria-label="Close">×</button></div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- toast ----------
type Toast = { id: number; text: string; bad?: boolean };
let toasts: Toast[] = [];
const subs = new Set<() => void>();
let nextId = 1;
function emitToasts() { for (const s of subs) s(); }
export function toast(text: string, bad = false) {
  const t = { id: nextId++, text, bad };
  toasts = [...toasts, t]; emitToasts();
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); emitToasts(); }, bad ? 6000 : 2600);
}
export function Toaster() {
  const list = useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => toasts);
  return <div className="toaster" aria-live="polite">{list.map((t) => <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`} role={t.bad ? "alert" : "status"}>{t.text}</div>)}</div>;
}

/** Runs a mutation, shows its error as a toast, returns whether it succeeded. */
export async function attempt(fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
  try { await fn(); if (ok) toast(ok); return true; }
  catch (e) { toast(e instanceof Error ? e.message : String(e), true); return false; }
}

export function useBusy(): [boolean, <T>(p: Promise<T>) => Promise<T>] {
  const [busy, setBusy] = useState(false);
  const wrap = async <T,>(p: Promise<T>) => { setBusy(true); try { return await p; } finally { setBusy(false); } };
  return [busy, wrap];
}

/** A key/value list for the facts about a thing. */
export function Facts({ items }: { items: Array<[ReactNode, ReactNode] | null | false> }) {
  return (
    <dl className="facts">
      {items.filter(Boolean).map((x, i) => { const [k, v] = x as [ReactNode, ReactNode]; return <div key={i}><dt>{k}</dt><dd>{v}</dd></div>; })}
    </dl>
  );
}

/** Yes/no with a mark that does not rely on colour alone. */
export function Check({ ok, label }: { ok: boolean | null | undefined; label?: ReactNode }) {
  if (ok == null) return <span className="check-mark none">—{label && <span>{label}</span>}</span>;
  return <span className={`check-mark ${ok ? "ok" : "no"}`}><span aria-hidden="true">{ok ? "✓" : "✕"}</span><span className="sr-only">{ok ? "yes" : "no"}</span>{label && <span>{label}</span>}</span>;
}
