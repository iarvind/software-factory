import { test } from "node:test";
import assert from "node:assert/strict";
import { ALWAYS_DENY, DEFAULT_DENY, DEFAULT_MODEL, EDIT_ALLOW, NEVER_DENY, READONLY_ALLOW, buildArgs, denyFor, parseLine } from "../server/lib/runners/claude.ts";
import { refusalSummary } from "../server/lib/tools.ts";
import { houseRules, reviewPrompt } from "../server/lib/prompts.ts";
import type { RunEvent, RunSpec } from "../server/lib/runners/index.ts";

/** The values after a flag, up to the next flag. */
function after(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !(args[j].startsWith("--") && args[j].length > 2); j++) out.push(args[j]);
  return out;
}
const base: RunSpec = { cwd: "/tmp/w", prompt: "do it" };

test("buildArgs: headless stream-json with only the project's settings", () => {
  const a = buildArgs(base);
  assert.deepEqual(a.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.deepEqual(after(a, "--setting-sources"), ["project"]);
  assert.ok(a.includes("--strict-mcp-config"));
  assert.deepEqual(after(a, "--model"), [DEFAULT_MODEL]);
  assert.ok(!a.includes("--json-schema") && !a.includes("--max-turns"));
});

test("buildArgs: tool mode none takes every tool away", () => {
  const a = buildArgs({ ...base, tools: { mode: "none" } });
  const i = a.indexOf("--tools");
  assert.equal(a[i + 1], "");
  assert.ok(!a.includes("--allowedTools") && !a.includes("--dangerously-skip-permissions"));
});

test("buildArgs: readonly is dontAsk with the read-only allow list and edits denied", () => {
  const a = buildArgs({ ...base, tools: { mode: "readonly", allow: ["Bash(make lint:*)"], deny: ["Bash(git log:*)"] } });
  assert.deepEqual(after(a, "--permission-mode"), ["dontAsk"]);
  assert.deepEqual(after(a, "--permission-prompts"), ["none"]);
  assert.deepEqual(after(a, "--tools"), ["Read,Grep,Glob,Bash"], "no web tools unless the project allows them");
  assert.deepEqual(after(buildArgs({ ...base, tools: { mode: "readonly", allow: ["WebFetch(domain:docs.example.com)"] } }), "--tools"), ["Read,Grep,Glob,Bash,WebFetch"]);
  const allowed = after(a, "--allowedTools");
  for (const r of READONLY_ALLOW) assert.ok(allowed.includes(r), r);
  assert.ok(allowed.includes("Bash(make lint:*)"));
  assert.ok(!allowed.includes("Bash(npm:*)"));
  const denied = after(a, "--disallowedTools");
  for (const r of [...ALWAYS_DENY, "Bash(git log:*)", "Edit", "Write", "NotebookEdit"]) assert.ok(denied.includes(r), r);
});

test("buildArgs: edit accepts edits, allows the toolchain, denies the dangerous", () => {
  const a = buildArgs({ ...base, tools: { mode: "edit", allow: [], deny: ["Bash(curl:*)"] } });
  assert.deepEqual(after(a, "--permission-mode"), ["acceptEdits"]);
  const allowed = after(a, "--allowedTools");
  for (const r of EDIT_ALLOW) assert.ok(allowed.includes(r), r);
  const denied = after(a, "--disallowedTools");
  for (const r of [...ALWAYS_DENY, "Bash(curl:*)"]) assert.ok(denied.includes(r), r);
  assert.ok(!denied.includes("Edit"));
  assert.deepEqual(buildArgs(base).filter((x) => x === "acceptEdits"), ["acceptEdits"], "edit is the default mode");
});

test("buildArgs: full skips permissions but keeps the deny list", () => {
  const a = buildArgs({ ...base, tools: { mode: "full", deny: ["Bash(terraform:*)"] } });
  assert.ok(a.includes("--dangerously-skip-permissions"));
  assert.ok(!a.includes("--permission-mode"));
  const denied = after(a, "--disallowedTools");
  for (const r of [...ALWAYS_DENY, "Bash(terraform:*)"]) assert.ok(denied.includes(r), r);
});

test("buildArgs: resume, a pinned session id, or a fresh one", () => {
  const r = buildArgs({ ...base, resumeSessionId: "s-old", sessionId: "ignored" });
  assert.deepEqual(after(r, "--resume"), ["s-old"]);
  assert.ok(!r.includes("--session-id"));
  const p = buildArgs({ ...base, sessionId: "11111111-2222-3333-4444-555555555555" });
  assert.deepEqual(after(p, "--session-id"), ["11111111-2222-3333-4444-555555555555"]);
  assert.ok(!p.includes("--resume"));
  assert.match(after(buildArgs(base), "--session-id")[0], /^[0-9a-f-]{36}$/);
});

test("buildArgs: limits, schema, model, prompt and directories pass through", () => {
  const schema = { title: "plan", type: "object" };
  const a = buildArgs({ ...base, model: "claude-x", fallbackModel: "claude-y", effort: "high", maxTurns: 7, maxBudgetUsd: 1.5, schema, systemPrompt: "rules", addDirs: ["/a", "/b"] });
  assert.deepEqual(after(a, "--model"), ["claude-x"]);
  assert.deepEqual(after(a, "--fallback-model"), ["claude-y"]);
  assert.deepEqual(after(a, "--effort"), ["high"]);
  assert.deepEqual(after(a, "--max-turns"), ["7"]);
  assert.deepEqual(after(a, "--max-budget-usd"), ["1.5"]);
  assert.deepEqual(JSON.parse(after(a, "--json-schema")[0]), schema);
  assert.deepEqual(after(a, "--append-system-prompt"), ["rules"]);
  assert.deepEqual(a.filter((_, i) => a[i - 1] === "--add-dir"), ["/a", "/b"]);
  assert.ok(!a.includes("--mcp-config"), "no MCP servers, no config");
});

test("buildArgs: a project's folders become read rules, its MCP servers an inline config, both allowed", () => {
  const mcp = { grafana: { command: "mcp-grafana", env: { GRAFANA_API_KEY: "${GRAFANA_API_KEY}" } } };
  for (const mode of ["readonly", "edit"] as const) {
    const a = buildArgs({ ...base, tools: { mode }, readDirs: ["/Users/me/shared/"], mcp });
    const allowed = after(a, "--allowedTools");
    assert.ok(allowed.includes("Read(//Users/me/shared/**)"), "read, not edit, and // marks an absolute path");
    assert.ok(allowed.includes("mcp__grafana"));
    assert.deepEqual(JSON.parse(after(a, "--mcp-config")[0]), { mcpServers: mcp }, "the ${NAME} reference is left for the CLI to fill in");
    assert.ok(!allowed.some((r) => r.startsWith("Edit(")));
  }
});

test("denyFor: a project lifts a default deny by naming the command, never the hard ones", () => {
  assert.deepEqual(denyFor([], []), ALWAYS_DENY);
  const d = denyFor(["Bash(kubectl get:*)", "Bash(curl:*)", "Bash(git push:*)", "Bash(sudo:*)"], ["Bash(terraform:*)"]);
  assert.ok(!d.includes("Bash(kubectl:*)") && !d.includes("Bash(curl:*)"));
  for (const r of NEVER_DENY) assert.ok(d.includes(r), r);
  for (const r of DEFAULT_DENY.filter((x) => !["Bash(kubectl:*)", "Bash(curl:*)"].includes(x))) assert.ok(d.includes(r), r);
  assert.ok(d.includes("Bash(terraform:*)"));
});

test("refusalSummary: one line per refused action and what would let it through", () => {
  assert.equal(refusalSummary([]), null);
  const s = refusalSummary([
    { tool_name: "Bash", tool_input: { command: "gcloud logging read 'severity>=ERROR'" } },
    { tool_name: "Bash", tool_input: { command: "gcloud logging read 'severity>=ERROR'" } },
    { tool_name: "Bash", tool_input: { command: "CLOUDSDK_CORE_PROJECT=x /opt/homebrew/bin/logcli query '{app=\"web\"}'" } },
    { tool_name: "Bash", tool_input: { command: "git push origin HEAD" } },
    { tool_name: "Bash", tool_input: { command: "git status && npm test 2>&1 | tail -20" } },
    { tool_name: "Bash", tool_input: { command: "npm test 2>&1" } },
    { tool_name: "Grep", tool_input: { pattern: "roots", path: "/elsewhere" } },
  ], "readonly")!;
  const lines = s.split("\n");
  assert.match(lines[0], /^6 action\(s\) were refused/, "the same call twice is one line");
  assert.match(s, /gcloud logging read .*add Bash\(gcloud:\*\) under Tools, Also allow/);
  assert.match(s, /logcli query .*add Bash\(logcli:\*\)/, "past an env prefix and a full path");
  assert.match(s, /git push origin HEAD \(never allowed/);
  assert.match(s, /git status && .*\(a chained command/);
  assert.match(s, /- Bash npm test 2>&1 \(this run only looks/, "2>&1 is not a background &");
  assert.match(s, /Grep roots \(outside the worktree\? add the folder/);
});

test("prompts: the tool rules and what the project allows; the reviewer gets the verification", () => {
  const p = { name: "Web", slug: "web", default_branch: "main", test_command: "npm test", build_command: null, instructions: null, delivery: "pr",
    tools: { mode: "edit", allow: ["Bash(gcloud:*)"], dirs: ["~/shared"], mcp: { grafana: {} } } };
  const rules = houseRules(p);
  assert.match(rules, /A refused action stays refused/);
  assert.match(rules, /Run one plain command at a time/);
  assert.match(rules, /`Bash\(gcloud:\*\)`/);
  assert.match(rules, /Folders you may read \(not change\) outside the worktree: ~\/shared/);
  assert.match(rules, /MCP servers: grafana/);
  assert.match(houseRules(p, "readonly"), /This run only looks/);
  assert.doesNotMatch(houseRules({ ...p, tools: { ...p.tools, mode: "full" } }), /allow-list/);
  assert.doesNotMatch(houseRules({ ...p, tools: undefined }), /Also allowed in this project/);
  const item = { id: 7, title: "t", body: "b", kind: null, priority: 3, labels: [], requester_name: null, external_url: null, plan: null };
  const r = reviewPrompt(item, p, "diff", "done", { summary: "`npm test` passed", output: "$ npm test\n✔ 12 tests" });
  assert.match(r, /Running tests, builds or anything else is refused/);
  assert.match(r, /## The factory's verification\n`npm test` passed\.\n```\n\$ npm test\n✔ 12 tests\n```/);
});

function feed(lines: unknown[]) {
  const events: RunEvent[] = [];
  const state: { sessionId?: string; lastText: string; result?: Record<string, unknown> } = { lastText: "" };
  for (const l of lines) parseLine(l as never, (e) => events.push(e), state as never);
  return { events, state };
}

test("parseLine: init, and a warning when the run is not on the subscription", () => {
  const init = { type: "system", subtype: "init", cwd: "/tmp/w", session_id: "0b6f2c1e-8d4a-4f3b-9e2a-5c7d1a3e9f40", tools: ["Bash", "Read"], model: "claude-opus-5-5", permissionMode: "acceptEdits", apiKeySource: "none" };
  const a = feed([init]);
  assert.deepEqual(a.events, [{ type: "init", sessionId: "0b6f2c1e-8d4a-4f3b-9e2a-5c7d1a3e9f40", model: "claude-opus-5-5", tools: ["Bash", "Read"] }]);
  assert.equal(a.state.sessionId, "0b6f2c1e-8d4a-4f3b-9e2a-5c7d1a3e9f40");
  const b = feed([{ ...init, apiKeySource: "ANTHROPIC_API_KEY" }]);
  assert.equal(b.events.length, 2);
  assert.deepEqual(b.events[1], { type: "log", level: "warn", message: "this run authenticates with ANTHROPIC_API_KEY, not the subscription login" });
});

test("parseLine: assistant text and tool calls, then tool results", () => {
  const { events, state } = feed([
    { type: "assistant", message: { model: "claude-opus-5-5", id: "msg_1", role: "assistant", content: [{ type: "text", text: "Running the tests." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test", description: "tests" } }] }, session_id: "s" },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "1 passing", is_error: false }] }, session_id: "s" },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "line a" }, { type: "text", text: "line b" }], is_error: true }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "x".repeat(5000) }] } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "not a tool result" }] } },
  ]);
  assert.deepEqual(events.slice(0, 4), [
    { type: "text", text: "Running the tests." },
    { type: "tool_use", name: "Bash", input: { command: "npm test", description: "tests" }, id: "toolu_1" },
    { type: "tool_result", id: "toolu_1", output: "1 passing", isError: false },
    { type: "tool_result", id: "toolu_2", output: "line a\nline b", isError: true },
  ]);
  const long = events[4] as { type: "tool_result"; output: string };
  assert.equal(long.type, "tool_result");
  assert.ok(long.output.startsWith("x".repeat(4000)) && long.output.endsWith("(1000 more characters)"));
  assert.equal(events.length, 5);
  assert.equal(state.lastText, "Running the tests.");
});

test("parseLine: rate_limit_event becomes usage", () => {
  const info = { status: "allowed", resetsAt: 1793437200, rateLimitType: "five_hour", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1793437200, status: "allowed" }, seven_day: { utilization: 0.4, resetsAt: 1793444400, status: "allowed" } } };
  const { events } = feed([{ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" }]);
  assert.deepEqual(events, [{ type: "usage", fiveHour: 0.1, sevenDay: 0.4, resetsAt: 1793437200, status: "allowed", raw: info }]);
});

test("parseLine: permission_denied becomes denied; api_retry a warning", () => {
  const { events } = feed([
    { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_9", decision_reason: "matched Bash(git push:*)" },
    { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 2000, error_status: 529, error: "overloaded" },
    { type: "system", subtype: "status", status: "requesting" },
  ]);
  assert.deepEqual(events[0], { type: "denied", tool: "Bash", id: "toolu_9", message: "matched Bash(git push:*)" });
  assert.deepEqual(events[1], { type: "log", level: "warn", message: "API retry 2/10: overloaded 529" });
  assert.equal(events.length, 2);
});

test("parseLine: the result is kept, with its session id", () => {
  const result = { type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "s-final", total_cost_usd: 0.42, num_turns: 6, structured_output: { ok: true }, permission_denials: [] };
  const { events, state } = feed([result, null, "junk", 42]);
  assert.equal(events.length, 0);
  assert.equal(state.sessionId, "s-final");
  assert.deepEqual(state.result, result);
});
