import type { Context } from "hono";
import { z } from "zod";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new HttpError(400, "body must be JSON"); }
  return parse(schema, raw);
}

/** Validates a value the server put together itself, with the same 400 a bad body gets. */
export function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export function idParam(c: Context, name = "id"): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `bad ${name}`);
  return n;
}

/** Builds "set a = $1, b = $2" from the provided keys only. JSON values are stringified for jsonb columns. */
export function setClause(obj: Record<string, unknown>, allowed: string[], startAt = 1, json: string[] = []): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const k of allowed) {
    if (!(k in obj) || obj[k] === undefined) continue;
    params.push(json.includes(k) && obj[k] !== null ? JSON.stringify(obj[k]) : obj[k]);
    parts.push(`${k} = $${startAt + params.length - 1}`);
  }
  if (!parts.length) throw new HttpError(400, "nothing to update");
  return { sql: parts.join(", "), params };
}

export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes");
