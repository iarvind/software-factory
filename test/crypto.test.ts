import { test } from "node:test";
import assert from "node:assert/strict";

process.env.FACTORY_SECRET = "test-secret-that-is-long-enough-0123456789";
const { encryptionConfigured, mask, open, seal } = await import("../server/lib/crypto.ts");

test("seal and open round-trip; every seal is different", () => {
  assert.equal(encryptionConfigured(), true);
  const secret = { token: "xoxb-123-456", nested: { a: [1, 2, 3] }, unicode: "naïve ✓" };
  const a = seal(secret);
  const b = seal(secret);
  assert.match(a, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.notEqual(a, b, "a fresh IV each time");
  assert.deepEqual(open(a), secret);
  assert.deepEqual(open(b), secret);
  assert.deepEqual(open(null), {});
  assert.deepEqual(open(""), {});
});

test("a tampered or foreign secret does not open", () => {
  const s = seal({ token: "abc" });
  const [v, iv, enc, tag] = s.split(".");
  const flip = (x: string) => (x[0] === "A" ? "B" : "A") + x.slice(1);
  assert.throws(() => open([v, iv, flip(enc), tag].join(".")));
  assert.throws(() => open([v, iv, enc, flip(tag)].join(".")));
  assert.throws(() => open([v, flip(iv), enc, tag].join(".")));
  assert.throws(() => open(["v2", iv, enc, tag].join(".")), /unreadable/);
  assert.throws(() => open("v1.only-two"), /unreadable/);
});

test("mask shows the last four characters only", () => {
  assert.equal(mask("xoxb-1234567890-abcd"), "••••••abcd");
  assert.equal(mask("ab"), "••••••ab");
  assert.equal(mask(""), "");
  assert.equal(mask(null), "");
  assert.equal(mask(undefined), "");
});
