// The notifier (a separate app, at NOTIFIER_URL) delivers to Telegram and hands back what is tapped there.
// Off when NOTIFIER_URL is empty. A slow or stopped notifier never slows the factory down.
import { randomBytes } from "node:crypto";
import { kvGet, kvSet } from "../db.ts";

const BASE = (process.env.NOTIFIER_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.NOTIFIER_TOKEN || "";
export const SERVICE = "factory";

export const notifierConfigured = () => Boolean(BASE);

export type Button = { text: string; data: string } | { text: string; url: string };
export type Content = { title?: string; description?: string; buttons?: Button[][]; compact?: boolean; level?: "info" | "success" | "warning" | "error" | "critical"; silent?: boolean; link?: string; details?: Record<string, string | number | boolean | null> };

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 5000): Promise<T> {
  if (!BASE) throw new Error("NOTIFIER_URL is not set");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`notifier ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function notify(content: Content & { dedupeKey?: string; dedupeWindowSec?: number }): Promise<{ id: string; status: string }> {
  return call("POST", "/api/v1/notify", { service: SERVICE, level: "info", ...content, title: content.title?.slice(0, 200), description: content.description?.slice(0, 8000) });
}

export async function hookSecret(): Promise<string> {
  let s = await kvGet<string>("notifier_secret");
  if (!s) { s = randomBytes(32).toString("base64url"); await kvSet("notifier_secret", s); }
  return s;
}

export const COMMANDS = [
  { command: "factory", description: "What the factory is doing right now" },
  { command: "build", description: "Ask the factory for something: /build <project> <what you want>" },
  { command: "approvals", description: "What is waiting for a decision" },
];

let lastHook: { ok: boolean; at: string; error?: string } | null = null;

export async function registerHook(port: number): Promise<void> {
  if (!BASE) return;
  try {
    await call("PUT", `/api/v1/services/${SERVICE}/hook`, { url: `http://127.0.0.1:${port}/api/notifier/hook`, secret: await hookSecret(), commands: COMMANDS, catchAll: false });
    if (!lastHook?.ok) console.log("notifier: hook registered");
    lastHook = { ok: true, at: new Date().toISOString() };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (lastHook?.error !== error) console.warn(`notifier: could not register the hook (${error})`);
    lastHook = { ok: false, at: new Date().toISOString(), error };
  }
}

export async function notifierStatus() {
  if (!BASE) return { configured: false, reachable: false, channels: 0, hook: null as typeof lastHook, url: null as string | null };
  try {
    const h = await call<{ ok: boolean; channels: number }>("GET", "/api/healthz", undefined, 2500);
    return { configured: true, reachable: Boolean(h.ok), channels: h.channels ?? 0, hook: lastHook, url: BASE };
  } catch (e) {
    return { configured: true, reachable: false, channels: 0, hook: lastHook, url: BASE, error: e instanceof Error ? e.message : String(e) };
  }
}
