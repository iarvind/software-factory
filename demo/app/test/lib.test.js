import test from "node:test";
import assert from "node:assert/strict";
import { greet, slugify } from "../lib.js";

test("greet", () => { assert.equal(greet("factory"), "Hello, factory!"); });
test("slugify", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Already-slug "), "already-slug");
  assert.equal(slugify("Ünïcode & symbols!"), "n-code-symbols");
});
