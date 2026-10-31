import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool, types } = pg;

// Dates come back as the 'YYYY-MM-DD' they were stored as; timestamps as ISO strings; numerics and bigints as numbers.
types.setTypeParser(1082, (v) => v);
const parseTz = types.getTypeParser(1184);
const parseTs = types.getTypeParser(1114);
types.setTypeParser(1184, (v) => (v == null ? null : new Date(parseTz(v)).toISOString()));
types.setTypeParser(1114, (v) => (v == null ? null : new Date(parseTs(v)).toISOString()));
types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));
types.setTypeParser(20, (v) => (v == null ? null : Number(v)));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — copy .env.example to .env (~/Self/dashboard/platform/db.sh url factory)");
  process.exit(1);
}

export const pool = new Pool({ connectionString: url, max: 8 });

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(sql, params);
  return r.rows as T[];
}

export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const r = await fn(client);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function migrate(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, "migrations");
  await q("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const applied = new Set((await q<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    await tx(async (c) => {
      await c.query(sql);
      await c.query("insert into schema_migrations (name) values ($1)", [f]);
    });
    console.log(`migrated ${f}`);
  }
}

// --- kv ----------------------------------------------------------------------
export async function kvGet<T>(key: string): Promise<T | null> {
  const r = await one<{ value: T }>("select value from kv where key = $1", [key]);
  return r ? r.value : null;
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  await q("insert into kv (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()", [key, JSON.stringify(value)]);
}
