// Secrets that integrations need (Slack tokens, Jira API tokens, GitHub PATs) are kept in the
// database encrypted with FACTORY_SECRET (AES-256-GCM). Without the secret the rows are noise.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const SECRET = process.env.FACTORY_SECRET || "";
export const encryptionConfigured = () => SECRET.length >= 16;

function key(): Buffer {
  if (!encryptionConfigured()) throw new Error("FACTORY_SECRET is not set (32+ random characters in .env) — integration secrets cannot be stored");
  return createHash("sha256").update(SECRET).digest();
}

export function seal(obj: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
}

export function open<T = Record<string, string>>(sealed: string | null | undefined): T {
  if (!sealed) return {} as T;
  const [v, iv, enc, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !enc || !tag) throw new Error("unreadable secret");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8")) as T;
}

/** For the UI: a secret shown as its last four characters. */
export const mask = (s: string | undefined | null) => (s ? `••••••${s.slice(-4)}` : "");
