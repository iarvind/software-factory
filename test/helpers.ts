// Shared by the tests: a clean test database, a throwaway git repository, a temporary directory.
// node --test runs files in parallel processes, so every file that uses the database holds an
// advisory lock for its whole run: they take turns instead of truncating under each other.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** For `describe(…, { skip: skipIfNoDb })`: a reason to skip, or false. */
export const skipIfNoDb: string | false = process.env.TEST_DATABASE_URL ? false : "TEST_DATABASE_URL is not set (see .env.test)";

const TABLES = "work_items, runs, events, approvals, feedback, posts, notes, sources, projects, users, sessions, api_tokens, audit, kv";

/** Points DATABASE_URL at the test database before db.ts reads it, migrates, empties every table. Call `close()` at the end. */
export async function useTestDb() {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = await import("../server/db.ts");
  const lock = await db.pool.connect();
  await lock.query("select pg_advisory_lock(820820)");
  await db.migrate();
  await db.q(`truncate ${TABLES} restart identity cascade`);
  return {
    ...db,
    /** Empties every table again, for files whose tests count rows across the whole database. */
    async reset(): Promise<void> {
      await db.q(`truncate ${TABLES} restart identity cascade`);
    },
    async close(): Promise<void> {
      lock.release(true); // ends the session, and with it the lock
      await db.pool.end();
    },
  };
}

export function tempDir(prefix = "factory-test-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/** A git repository on `main` with a package.json whose `npm test` passes (or fails, with `failing`; or is `test`), one commit. */
export function tempRepo(opts: { failing?: boolean; test?: string } = {}): string {
  const dir = tempDir("factory-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@localhost");
  const test = opts.test ?? (opts.failing ? 'node -e "process.exit(1)"' : "node test.js");
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", private: true, scripts: { test } }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "test.js"), 'console.log("ok");\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

export const gitIn = git;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
