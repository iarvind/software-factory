// A very small data layer: GET results are cached by path, mutations invalidate
// by prefix (or by exact key), and every mounted hook re-fetches when its key is invalidated.
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** `at` is when the data arrived: a page mounted on an entry older than FRESH_MS refetches it quietly. */
type Entry = { data: unknown; stale: boolean; at: number };
const cache = new Map<string, Entry>();
const FRESH_MS = 30_000;
type Match = (key: string) => boolean;
const listeners = new Set<(match: Match) => void>();
let onUnauthorized: (() => void) | null = null;
let onPending: (() => void) | null = null;
let onForbidden: (() => void) | null = null;
/** 401: the session is gone, show the login screen. */
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }
/** 403 for a pending account: show the waiting screen. */
export function setPendingHandler(fn: () => void) { onPending = fn; }
/** 403 that names a role: the role (or the approver setting) changed under us, so read the session again. */
export function setForbiddenHandler(fn: () => void) { onForbidden = fn; }
/** Something other than a fetch learned the session is gone (the event stream). */
export function notifyUnauthorized() { onUnauthorized?.(); }

async function request(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) { onUnauthorized?.(); throw new ApiError(401, "Sign in again to continue."); }
  return res;
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await request(path, init);
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
    if (res.status === 403 && /waiting for an admin/i.test(msg)) onPending?.();
    else if (res.status === 403 && /admins only|members only|viewers|only an admin/i.test(msg)) onForbidden?.();
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

/** A GET whose body is plain text (a file from a worktree), never parsed as JSON. */
export async function apiText(path: string): Promise<string> {
  const res = await request(path);
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (JSON.parse(text) as { error?: string }).error ?? msg; } catch { /* not JSON */ }
    throw new ApiError(res.status, msg);
  }
  return text;
}

export const post = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body ?? {} });
export const put = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body: body ?? {} });
export const patch = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body: body ?? {} });
export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });

/** GETs in flight, shared by every hook that asks for the same key at the same time. */
const inflight = new Map<string, Promise<unknown>>();
function shared<T>(path: string): Promise<T> {
  let p = inflight.get(path);
  if (!p) { p = api<T>(path).finally(() => { if (inflight.get(path) === p) inflight.delete(path); }); inflight.set(path, p); }
  return p as Promise<T>;
}

function invalidateWhere(match: Match) {
  for (const k of [...inflight.keys()]) if (match(k)) inflight.delete(k); // a request that started before the change is not an answer to it
  for (const [k, v] of cache) if (match(k)) v.stale = true;
  for (const fn of listeners) fn(match);
}
/** Mark cached GETs whose path starts with any prefix as stale and refetch them where mounted. */
export function invalidate(...prefixes: string[]) {
  const list = prefixes.length ? prefixes : ["/api/"];
  invalidateWhere((k) => list.some((p) => k.startsWith(p)));
}
/** Exactly these keys (and their query-string variants): `/api/items/12` but not `/api/items/123`. */
export function invalidateKey(...keys: string[]) {
  invalidateWhere((k) => keys.some((key) => k === key || k.startsWith(`${key}?`)));
}
/** Put a fresh value in the cache (after a mutation that returned it) without a round trip. */
export function prime<T>(key: string, data: T) {
  cache.set(key, { data, stale: false, at: Date.now() });
  for (const fn of listeners) fn((k) => k === key);
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>(() => (path && cache.get(path)?.data) as T | undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !!path && !cache.has(path));
  const seq = useRef(0);

  const load = useCallback(async (silent = false) => {
    if (!path) return;
    const id = ++seq.current;
    if (!silent) setLoading(!cache.has(path));
    try {
      const d = await shared<T>(path);
      if (id !== seq.current) return;
      cache.set(path, { data: d, stale: false, at: Date.now() });
      setData(d);
      setError(null);
    } catch (e) {
      if (id !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (!path) { setData(undefined); return; }
    const hit = cache.get(path);
    if (hit) { setData(hit.data as T); if (hit.stale || Date.now() - hit.at > FRESH_MS) load(true); } else { setData(undefined); load(); }
    const fn = (match: Match) => {
      if (!match(path)) return;
      const e = cache.get(path);
      if (e && !e.stale) setData(e.data as T); else load(true);
    };
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, [path, load]);

  return { data, error, loading, reload: () => load(true) };
}
