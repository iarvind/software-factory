// The live feed: one EventSource for the whole app, fanned out to whoever is listening,
// and a separate one-item stream for the item page.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { api, invalidate, invalidateKey, notifyUnauthorized } from "./api";
import type { Ev } from "./types";

type Listener = (e: Ev) => void;
const listeners = new Set<Listener>();
const helloListeners = new Set<() => void>();
let source: EventSource | null = null;
let state: "connecting" | "open" | "down" = "connecting";
const stateSubs = new Set<() => void>();
const setState = (s: typeof state) => { if (s !== state) { state = s; for (const fn of stateSubs) fn(); } };
/** The newest event this tab has seen: a new connection asks the server for what came after it. */
let lastId = 0;

/** An HTTP error ends an EventSource for good, and a 401 looks like any other: ask the session whether we are still signed in. */
function checkSession() {
  api<{ ok: boolean }>("/api/session").then((s) => { if (!s?.ok) notifyUnauthorized(); }, () => { /* the server is down; the retry finds out */ });
}

export function startLive(): () => void {
  if (source) return () => {};
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let opened = false;
  const connect = () => {
    const es = new EventSource(lastId ? `/api/events/stream?after=${lastId}` : "/api/events/stream");
    source = es;
    es.addEventListener("hello", () => {
      setState("open");
      // Anything the replay cannot carry (an item edited, a diff rebuilt) is fetched again after a gap.
      if (opened) invalidate("/api/items/", "/api/activity", "/api/board", "/api/approvals", "/api/status");
      opened = true;
      for (const fn of helloListeners) fn();
    });
    es.addEventListener("event", (m) => {
      let e: Ev;
      try { e = JSON.parse((m as MessageEvent<string>).data) as Ev; } catch { return; }
      if (e.id > lastId) lastId = e.id;
      for (const fn of listeners) fn(e);
    });
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) { setState("connecting"); return; }
      // An HTTP error (a proxy's 502 during a restart, a 401) ends an EventSource for good: start a new one.
      setState("down");
      es.close();
      checkSession();
      if (!stopped) retry = setTimeout(connect, 5000);
    };
  };
  connect();
  return () => { stopped = true; if (retry) clearTimeout(retry); source?.close(); source = null; setState("connecting"); };
}

/** Every event as it happens. The callback may change between renders. */
export function useLive(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
}
/** Called whenever the stream (re)connects: anything missed while it was down should be fetched again. */
export function useLiveHello(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l = () => ref.current();
    helloListeners.add(l);
    return () => { helloListeners.delete(l); };
  }, []);
}
export const useLiveState = () => useSyncExternalStore((cb) => { stateSubs.add(cb); return () => { stateSubs.delete(cb); }; }, () => state);

const itemTimers = new Map<number, { deep: boolean }>();
/** Fetch an item's page again shortly, folding a burst of events into one request. `deep` also refetches
 *  what hangs under it (`/api/items/ID/diff`): a commit or a status change can change the diff. */
export function refreshItemSoon(id: number, deep = false) {
  const pending = itemTimers.get(id);
  if (pending) { pending.deep ||= deep; return; }
  const entry = { deep };
  itemTimers.set(id, entry);
  setTimeout(() => {
    itemTimers.delete(id);
    invalidateKey(`/api/items/${id}`);
    if (entry.deep) invalidate(`/api/items/${id}/`);
  }, 500);
}

/** One item's events only (`?item=ID`), with a hello on every (re)connect; `reconnect` is false on the first. */
export function useItemStream(itemId: number | null, onEvent: Listener, onHello: (reconnect: boolean) => void) {
  const ev = useRef(onEvent);
  const hi = useRef(onHello);
  ev.current = onEvent;
  hi.current = onHello;
  useEffect(() => {
    if (!itemId) return;
    let es: EventSource | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    let opened = false;
    const connect = () => {
      const s = new EventSource(`/api/events/stream?item=${itemId}${last ? `&after=${last}` : ""}`);
      es = s;
      s.addEventListener("hello", () => { const again = opened; opened = true; hi.current(again); });
      s.addEventListener("event", (m) => {
        let e: Ev;
        try { e = JSON.parse((m as MessageEvent<string>).data) as Ev; } catch { return; /* a malformed line */ }
        if (e.id > last) last = e.id;
        ev.current(e);
      });
      s.onerror = () => {
        if (s.readyState !== EventSource.CLOSED || stopped) return;
        s.close();
        checkSession();
        retry = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); es?.close(); };
  }, [itemId]);
}
