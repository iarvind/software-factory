import { after, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

process.env.GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com";
// auth.ts imports db.ts, which wants a URL; nothing here touches the database.
process.env.DATABASE_URL ||= process.env.TEST_DATABASE_URL || "postgres://localhost/unused";
const { _useKeys, verifyIdClaims, AuthError } = await import("../server/lib/auth.ts");
const { pool } = await import("../server/db.ts");
after(() => pool.end());

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };
_useKeys([{ kid: "k1", kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" }]);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(claims: Record<string, unknown>, opts: { header?: Record<string, unknown>; key?: KeyObject } = {}): string {
  const h = b64(opts.header ?? { alg: "RS256", kid: "k1", typ: "JWT" });
  const p = b64(claims);
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), opts.key ?? privateKey).toString("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = (over: Record<string, unknown> = {}) => ({ iss: "https://accounts.google.com", aud: "client-123.apps.googleusercontent.com", sub: "1234", email: "ada@example.com", email_verified: true, name: "Ada", nonce: "nonce-abc", iat: now(), exp: now() + 3600, ...over });

test("a good ID token gives its claims", async () => {
  const c = await verifyIdClaims(jwt(good()), "nonce-abc");
  assert.deepEqual(c, { sub: "1234", email: "ada@example.com", name: "Ada", picture: undefined });
  assert.equal((await verifyIdClaims(jwt(good({ iss: "accounts.google.com" })), "nonce-abc")).email, "ada@example.com", "both issuer spellings");
});

test("everything that matters is checked", async () => {
  const cases: Array<[string, string, RegExp]> = [
    ["another app's token", jwt(good({ aud: "someone-else" })), /different app/],
    ["the wrong nonce", jwt(good()), /did not start in this browser/],
    ["no nonce", jwt(good({ nonce: undefined })), /did not start in this browser/],
    ["expired", jwt(good({ exp: now() - 3600 })), /expired/],
    ["no expiry", jwt(good({ exp: undefined })), /expired/],
    ["from the future", jwt(good({ iat: now() + 3600 })), /future/],
    ["an unverified email", jwt(good({ email_verified: false })), /vouch/],
    ["email_verified missing", jwt(good({ email_verified: undefined })), /vouch/],
    ["no email", jwt(good({ email: undefined })), /vouch/],
    ["not Google", jwt(good({ iss: "https://evil.example" })), /not issued by Google/],
    ["signed with another key", jwt(good(), { key: other.privateKey }), /signature/],
    ["HS256", jwt(good(), { header: { alg: "HS256", kid: "k1" } }), /algorithm/],
    ["no kid", jwt(good(), { header: { alg: "RS256" } }), /algorithm/],
    ["malformed", "abc.def", /malformed/],
    ["unreadable", "a.b.c", /unreadable/],
  ];
  for (const [what, token, re] of cases) {
    const nonce = what === "the wrong nonce" ? "another-nonce" : "nonce-abc";
    await assert.rejects(verifyIdClaims(token, nonce), (e: unknown) => e instanceof AuthError && re.test((e as Error).message), what);
  }
});

test("a payload changed after signing fails the signature", async () => {
  const [h, , s] = jwt(good()).split(".");
  await assert.rejects(verifyIdClaims(`${h}.${b64(good({ email: "mallory@example.com" }))}.${s}`, "nonce-abc"), /signature/);
});
