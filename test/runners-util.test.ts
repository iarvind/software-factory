import { test } from "node:test";
import assert from "node:assert/strict";
import { clip, extractJson, schemaInstruction } from "../server/lib/runners/util.ts";

test("extractJson: a fenced json block", () => {
  assert.deepEqual(extractJson('Here is the plan.\n\n```json\n{"summary": "x", "steps": ["a"]}\n```\n'), { summary: "x", steps: ["a"] });
  assert.deepEqual(extractJson('```JSON\r\n{"a":1}\r\n```'), { a: 1 }, "any case, CRLF");
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 }, "a bare fence");
});

test("extractJson: the last fenced object wins; other languages are skipped", () => {
  const text = 'First try:\n```json\n{"v": 1}\n```\nCorrected:\n```json\n{"v": 2}\n```\nAnd some code:\n```ts\nconst x = {"v": 3};\n```\n';
  assert.deepEqual(extractJson(text), { v: 2 });
  assert.deepEqual(extractJson('```json\n{not json}\n```\n```json\n{"ok": true}\n```\n```json\nnope\n```'), { ok: true }, "an unparseable fence is passed over");
  assert.deepEqual(extractJson('```json\nThe answer: {"ok": true} (as asked)\n```'), { ok: true }, "prose inside the fence");
});

test("extractJson: whole text, or the last balanced object in prose", () => {
  assert.deepEqual(extractJson('  {"a": {"b": [1, 2, {"c": null}]}}  '), { a: { b: [1, 2, { c: null }] } });
  assert.deepEqual(extractJson('I used {braces} in prose. Answer: {"verdict": "approve", "findings": []} — done.'), { verdict: "approve", findings: [] });
  assert.deepEqual(extractJson('one {"a": 1} two {"b": {"c": 2}} end'), { b: { c: 2 } }, "the last top-level object, not an inner one");
  assert.deepEqual(extractJson('{"text": "a } inside a string and a \\" quote {", "n": 1}'), { text: 'a } inside a string and a " quote {', n: 1 });
  assert.deepEqual(extractJson('Unclosed { here, then {"ok": 1}'), { ok: 1 });
  assert.deepEqual(extractJson('﻿{"bom": true}'), { bom: true });
});

test("extractJson: nothing to find", () => {
  for (const t of ["", null, undefined, "no json here", "[1, 2, 3]", "42", '"a string"', "{ broken: json }", '```json\n[1,2]\n```', "{\"a\": 1"]) {
    assert.equal(extractJson(t as string), undefined, JSON.stringify(t));
  }
});

test("schemaInstruction asks for a fenced object and carries the schema", () => {
  const s = { title: "note", type: "object", required: ["note"], properties: { note: { type: "string" } } };
  const text = schemaInstruction(s);
  assert.match(text, /ONLY one JSON object/);
  assert.match(text, /```json/);
  assert.deepEqual(extractJson(text), s, "the schema itself is readable from the instruction");
});

test("clip keeps 4000 characters and counts the rest", () => {
  assert.equal(clip("short"), "short");
  const c = clip("y".repeat(4010));
  assert.equal(c, `${"y".repeat(4000)}\n… (10 more characters)`);
  assert.equal(clip("abcdef", 3), "abc\n… (3 more characters)");
});
