// What the runners other than claude share: spawning a CLI that streams JSONL under the same
// rules as claude.ts (the prompt on stdin, a timeout, cancel by SIGTERM and SIGKILL five seconds
// later), and getting a structured answer out of a model that can only be asked for one in words.
import { spawn } from "node:child_process";
import { ndjson, killTree, trackChild } from "./index.ts";

export type CliExit = { code: number | null; killedBy: string | null; stderr: string; durationMs: number };

/** Runs `bin args` in cwd with `input` on stdin; every stdout line goes to onLine (obj is null for a line that is not JSON), with a `stop` the parser can pull. */
export function spawnCli(o: {
  bin: string; args: string[]; cwd: string; env: Record<string, string>; input: string; timeoutMs?: number; signal: AbortSignal;
  onLine: (obj: unknown, raw: string, stop: (why: string) => void) => void;
}): Promise<CliExit> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stderr = "";
    let killedBy: string | null = null;
    const child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    trackChild(child);
    const stop = (why: string) => {
      if (killedBy) return;
      killedBy = why;
      killTree(child);
    };
    const reader = ndjson((obj, raw) => o.onLine(obj, raw, stop));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => reader.push(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    const timer = setTimeout(() => stop("timeout"), o.timeoutMs ?? 60 * 60 * 1000);
    const onAbort = () => stop("cancelled");
    if (o.signal.aborted) onAbort(); else o.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => { stderr += `\n${err.message}`; });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onAbort);
      reader.flush();
      resolve({ code, killedBy, stderr: stderr.slice(-4000), durationMs: Date.now() - started });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(o.input);
  });
}

/** Tool output as the claude runner keeps it: the first 4000 characters and a count of the rest. */
export const clip = (text: string, n = 4000) => (text.length > n ? `${text.slice(0, n)}\n… (${text.length - n} more characters)` : text);

/** For a CLI with no schema flag: what to add to the prompt so the answer comes back as JSON that extractJson can read. */
export function schemaInstruction(schema: object): string {
  return [
    "", "", "---", "",
    "Answer format: when you are done, reply with ONLY one JSON object that matches the JSON Schema below, inside a single ```json fenced block, with nothing after it. No comments inside the JSON.",
    "", "```json", JSON.stringify(schema, null, 2), "```", "",
  ].join("\n");
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

/** Where the bracket opened at `start` closes, minding strings and escapes; -1 when it never does or the brackets do not pair. */
function closing(s: string, start: number): number {
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") { if (stack.pop() !== c) return -1; if (!stack.length) return i; }
  }
  return -1;
}

/** The last top-level JSON object in free text (prose, stray braces and inner objects are skipped). */
function lastObject(s: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (let i = s.indexOf("{"); i >= 0; ) {
    const end = closing(s, i);
    const v = end > 0 ? parse(s.slice(i, end + 1)) : undefined;
    if (isObject(v)) { found = v; i = s.indexOf("{", end + 1); } else i = s.indexOf("{", i + 1);
  }
  return found;
}

/**
 * The structured answer in a model's final text: the last ```json (or bare ```) fenced block
 * that holds an object, else the whole text when it is one object, else the last balanced
 * object anywhere in it. Undefined when there is none. Only objects count: the factory's
 * schemas are all objects, and a bare array or number is never the answer.
 */
export function extractJson(text: string | null | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const s = (text.length > 500_000 ? text.slice(-500_000) : text).replace(/^﻿/, "");
  const fences = [...s.matchAll(/```[ \t]*([\w-]*)[ \t]*\r?\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const [, lang, body] = fences[i];
    if (lang && !/^(json|jsonc|json5)$/i.test(lang)) continue;
    const v = parse(body.trim());
    if (isObject(v)) return v;
    const inner = lastObject(body);
    if (inner) return inner;
  }
  const whole = parse(s.trim());
  if (isObject(whole)) return whole;
  return lastObject(s);
}
