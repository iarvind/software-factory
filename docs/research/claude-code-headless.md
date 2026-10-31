# Claude Code headless mode: reference for the software factory's model runner

Researched 2026-10-30 against **Claude Code 2.1.314** (`/Users/me/.local/bin/claude` → `~/.local/share/claude/versions/2.1.314`, native arm64 Mach-O), signed in with a **claude.ai subscription** (`claude auth status --json` → `authMethod: "claude.ai"`, no API key).

## How things were checked

Each claim is tagged with how it was checked:

| Tag | Meaning |
|---|---|
| **[local]** | Checked against the installed 2.1.314: `claude --help`, `claude -p --help`, sub-command help, flag-parsing probes run with empty stdin (no model call), strings in the binary, or the one smoke test. |
| **[docs]** | Read on `https://code.claude.com/docs/en/*` (fetched 2026-10-30). The docs track the latest release, which may be newer than 2.1.314. |
| **[unverified]** | Inferred, taken from community sources, or not testable without spending quota. Treat as a hypothesis. |

The one smoke test was run from an empty temp dir, with the parent Claude Code session's `CLAUDE*` env vars removed:

```bash
claude -p "Reply with exactly: ok" --output-format stream-json --verbose --include-partial-messages --max-turns 1
```

It exited 0 and emitted 11 JSONL lines; the real output is quoted in §2. `stream-json` was used instead of `json` so that one run would also capture the `system/init`, `stream_event`, `assistant` and `rate_limit_event` shapes. The final `result` line is the same object that `--output-format json` prints [docs]. The run left a transcript in `~/.claude/projects/-private-tmp-cc-smoke/`.

---

## 0. TL;DR: what matters for the factory

1. **Do not use `--bare`.** It never reads OAuth or keychain credentials, or `CLAUDE_CODE_OAUTH_TOKEN`. It only authenticates with `ANTHROPIC_API_KEY` or an `apiKeyHelper` passed via `--settings` [local help text + docs]. This machine has neither, so `--bare` cannot work with the subscription. The docs say bare "will become the default for `-p` in a future release" [docs]. Watch for that change, because it would break the factory.
2. **Scrub the child environment.** Two kinds of variables get inherited and change behaviour:
   - `ANTHROPIC_API_KEY`: in `-p` mode it "is always used when present", even when you are logged in [docs]. That silently switches the run to API billing.
   - `CLAUDE_CODE_EFFORT_LEVEL` and `ANTHROPIC_MODEL`: these override the matching flags and settings [docs].
   
   A process started from inside a Claude Code session also inherits `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` and similar [local: present in this environment]. Build the child env from an allowlist (§6).
3. **Check the auth source on every run.** The `system/init` event carries `apiKeySource`. With the subscription it is `"none"` [local]. Abort the run if it is anything else.
4. **The default permission mode in `-p` is Manual (`default`)** (v2.1.302+). Anything that needs approval is **denied, not prompted**. Denials show up as `system/permission_denied` events and in the result's `permission_denials` array [docs]. Pass an explicit `--permission-mode` (for factory jobs, `dontAsk` plus allow rules, or `acceptEdits`) and `--permission-prompts none` [local + docs].
5. **In `-p`, `permissions.allow` rules from a repo's committed `.claude/settings.json` are ignored** unless that folder is trusted. Claude Code only prints `this workspace has not been trusted` to stderr. Hooks, `env` and `deny` rules from the same file *are* applied [docs]. Put allow rules in a factory-owned `--settings` file or in `--allowedTools`, not in the repo.
6. **`total_cost_usd` is a list-price estimate.** The smoke test reported `costBasis: "list"` [local]. Subscription usage is metered against a 5-hour window and a weekly window. Live utilisation of both arrives in `rate_limit_event` lines on the stream-json output (`unifiedWindows.five_hour.utilization`, `seven_day.utilization`) [local]. Throttle dispatch on those fields.
7. **Resume is by session id:** `claude -p --resume <uuid> "…feedback…"` keeps the same id unless you add `--fork-session` [docs]. You can pre-assign the id with `--session-id <uuid>` [local]. Put review feedback in the user prompt. The system prompt is snapshotted on the first request and reused on resume [docs].
8. **One git worktree per concurrent task, created by the factory** (`git worktree add`), with `spawn(..., { cwd })`. There is no `--cwd` flag [local]. `claude -p --worktree` exists, but in `-p` mode it does not clean up the worktree and leaves a lock behind [docs].
9. **Some working flags are hidden from `--help`:** `--max-turns`, `--permission-prompt-tool`, `--system-prompt-file`, `--append-system-prompt-file` [local].
10. **Send the prompt on stdin**, or after all options in `--flag=value` form. Several options are variadic (`--allowedTools <tools...>`, `--add-dir <directories...>`, `--mcp-config <configs...>`) and will consume a following positional prompt [local: help shows `<x...>`; the consuming behaviour is commander's documented semantics, not tested here].

---

## 1. Flag reference: 2.1.314 binary vs docs

Status values:

- **help**: listed in `claude --help` 2.1.314.
- **hidden**: defined in the binary with `.hideHelp()` and accepted by the parser.
- **absent**: `error: unknown option` [local].

`claude -p --help` prints the same option list as `claude --help`. Only the `Commands:` section differs [local].

### 1.1 Flags you asked about

| Flag | 2.1.314 | Notes |
|---|---|---|
| `-p, --print` | help | Non-interactive mode. Skips the workspace trust dialog. In this mode, settings files that fail validation are **silently ignored** [local help]. |
| `--output-format text\|json\|stream-json` | help | `--print` only. `stream-json` **requires `--verbose`** in print mode (the binary contains the string `Error: When using --print, --output-format=stream-json requires --verbose`) [local]. |
| `--input-format text\|stream-json` | help | `stream-json` input requires `--output-format stream-json` (probe error: `--input-format=stream-json requires output-format=stream-json.`) [local]. |
| `--json-schema <schema>` | help | Validated JSON output; the result goes in `structured_output`. An invalid value fails fast (`Error: --json-schema is not valid JSON: …`) [local]. The `format` keyword is treated as an annotation and not enforced [docs]. |
| `--include-partial-messages` | help | Requires `--print` and `--output-format=stream-json`. Otherwise: `Error: --include-partial-messages requires --print and --output-format=stream-json.` [local]. |
| `--verbose` | help | Required for stream-json. Overrides the `viewMode` setting [docs]. |
| `--max-turns <n>` | **hidden** | Print mode only. On reaching the limit it "exits with an error" (result subtype `error_max_turns`) [local + docs]. |
| `--max-budget-usd <amount>` | help | Print mode only. Checked against the client-side cost estimate. Spend can overshoot the cap; subagent spend counts toward it. On resume, totals restored from earlier runs are not counted [docs]. Works with the subscription because it uses the estimate (see §5). |
| `--model <m>` | help | Alias (`fable`, `opus`, `sonnet`, `haiku`) or full id (e.g. `claude-opus-5-5`). Overrides `ANTHROPIC_MODEL` and the `model` setting [local + docs]. Smoke-test default was `claude-opus-5-5` [local]. |
| `--fallback-model <m[,m2…]>` | help | Comma-separated chain, used when the primary is overloaded or unavailable. Retries the primary at the start of each user turn [local]. |
| `--effort low\|medium\|high\|xhigh\|max` | help | Docs also list `ultracode`, which 2.1.314 accepts silently [local probe]. An unknown value only warns. **`CLAUDE_CODE_EFFORT_LEVEL` in the env overrides this flag** [docs]. |
| `--permission-mode <mode>` | help | Choices printed: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`. **`default` is accepted** as an alias of `manual`: the probe parsed it and the init event reports `"permissionMode":"default"`. `bogus` is rejected [local]. |
| `--dangerously-skip-permissions` | help | Same as `--permission-mode bypassPermissions`. Refuses to run as root or under sudo outside a recognised sandbox [docs]. |
| `--allow-dangerously-skip-permissions` | help | Makes bypass available without starting in it. Mainly for interactive use. |
| `--permission-prompts host\|none` | help | Who answers prompts in `--print`. `none` auto-denies anything that would prompt and tells Claude not to retry [local]. It also removes tools that need a person, such as `AskUserQuestion` [docs]. |
| `--permission-prompt-tool <mcp__srv__tool>` | **hidden** | An MCP tool that answers permission prompts in `-p` (§3.4) [local + docs]. |
| `--allowedTools, --allowed-tools <tools...>` | help | Allow rules (permission rule syntax), comma- or space-separated. **Variadic** [local]. |
| `--disallowedTools, --disallowed-tools <tools...>` | help | Deny rules. A bare tool name removes the tool from context; a scoped rule (`Bash(rm *)`) blocks matching calls [docs]. |
| `--tools <tools...>` | help | Restricts which *built-in* tools exist. `""` = none, `default` = the default set. Does not affect MCP tools (use `--disallowedTools "mcp__*"`) [local + docs]. The default set on macOS has **no `Glob`/`Grep`** [docs; confirmed by the smoke-test tool list]. |
| `--system-prompt <text>` | help | Replaces the whole default prompt, which also drops the git-status snapshot [docs]. |
| `--system-prompt-file <file>` | **hidden** | Replacement prompt read from a file [local]. |
| `--append-system-prompt <text>` | help | Appends to the default prompt (recommended for the factory). |
| `--append-system-prompt-file <file>` | **hidden** | Appended text read from a file [local]. |
| `--system-prompt-snapshot on\|off` | help | Default `on`: the prompt is recorded on the first request and reused on every resume until compaction [local + docs]. |
| `--add-dir <directories...>` | help | Extra directories with file access. Most `.claude/` config in those directories is **not** loaded [docs]. Variadic. |
| `--mcp-config <configs...>` | help | JSON files or JSON strings. With `-p`, Claude Code waits up to `MCP_TIMEOUT` (default 30 s) for servers to connect [docs]. Variadic. |
| `--strict-mcp-config` | help | Use only the `--mcp-config` servers and ignore `.mcp.json`, user servers and so on [local + docs]. |
| `--settings <file-or-json>` | help | Settings layer above user, project and local, below managed. The file must be at most 2 MiB [docs]. |
| `--setting-sources user,project,local` | help | Choose which settings files load [local]. |
| `--agents <json-or-file>` | help | Session-only subagents. With `--print` the value may be a **file path** [local help; probe: `--agents file not found: …`]. |
| `--agent <name>` | help | Run the whole session *as* the named agent. |
| `--session-id <uuid>` | help | Pre-assign the session id. Must be a valid UUID [local]. |
| `-r, --resume [id\|name]` | help | Resume by id, name, or absolute path to a `.jsonl` transcript. The id lookup searches the current project and its worktrees, then every project on the machine [docs]. |
| `-c, --continue` | help | Most recent conversation in the cwd. **`-c` is `--continue`, not cwd.** |
| `--fork-session` | help | Use with `--resume`/`--continue` to get a new session id [local]. |
| `-n, --name <name>` | help | Display name. `--resume <name>` works [local + docs]. |
| `-w, --worktree [name]` | help | Creates `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`. Fails outside git unless a `WorktreeCreate` hook exists (`Error: Can only use --worktree in a git repository…`) [local + docs]. |
| `--tmux` | help | Requires `--worktree`. Interactive only. |
| `--bare` | help | Minimal mode, sets `CLAUDE_CODE_SIMPLE=1`. **Auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`; OAuth and keychain are never read** [local help]. Unusable on this machine. |
| `--no-session-persistence` | help | Print-only. The session cannot be resumed [local]. |
| `--disable-slash-commands` | help | Disables all skills and commands [local]. |
| `--cwd` | **absent** | `error: unknown option '--cwd'` [local]. Set the working directory with `spawn(..., { cwd })`. (`claude agents --cwd <path>` exists but only filters the background-session list.) |

### 1.2 Other flags useful to the factory

| Flag | 2.1.314 | Notes |
|---|---|---|
| `--include-hook-events` | help | Hook lifecycle events in stream-json. |
| `--forward-subagent-text` | help | Include subagent text and thinking blocks, tagged with `parent_tool_use_id`. |
| `--replay-user-messages` | help | Echo stdin user messages on stdout (stream-json input and output). |
| `--restricted` | help | Removes Bash and other code-running tools plus WebFetch, ignores user/project/local settings, refuses bypass. Too restrictive for coding tasks. |
| `--safe-mode` | help | Disables **all** customizations, including the project's CLAUDE.md, hooks and agents. Not suitable when the factory relies on repo config. |
| `--exclude-dynamic-system-prompt-sections` | help | Moves cwd, env and git status into the first user message to improve cross-run prompt caching. |
| `--autocompact <auto\|tokens>` | help | Auto-compact window. |
| `--debug [filter]`, `--debug-file <path>` | help | e.g. `--debug-file /tmp/x.log` (`--debug=hooks,mcp`). Debug output goes to a file, not the terminal [docs]. |
| `--plugin-dir`, `--plugin-url` | help | Session-only plugins. |
| `--prompt-suggestions` | help | Emits `prompt_suggestion` messages. Leave off; it costs tokens. |
| `--bg`, `--background` | help | Rejected with `-p` [docs]. |
| `--init`, `--init-only`, `--maintenance` | **hidden** | Run `Setup` hooks [local + docs]. |
| `--thinking enabled\|adaptive\|disabled`, `--thinking-display`, `--max-thinking-tokens` (deprecated) | **hidden** | [local]. Docs say thinking cannot be turned off on Opus/Sonnet/Haiku 5.5 or Fable [docs]. |
| `--resume-session-at <msg id>`, `--rewind-files <user-msg-id>` | **hidden** | Truncating resume and file rewind [local]. |
| `--append-subagent-system-prompt[-file]` | **hidden** | Appends to every subagent's system prompt (print only) [local]. |
| `--task-budget <tokens>` | **hidden** | API-side task budget [local]. |
| `--exec` | **absent** | Docs describe `--bg … --exec`; 2.1.314 says `unknown option '--exec'` [local]. |
| `--output-style` | **absent** | Not a CLI flag. Use the `outputStyle` setting or the `/output-style <name>` command in the prompt [local + docs]. |
| `--brief`, `--file <specs...>` | help | In 2.1.314 help but not in the docs flag table. |

Read-only sub-commands worth using: `claude --version`, `claude auth status --json`, `claude doctor`, `claude mcp list`, `claude agents --json`. Clean-up: `claude purge [path]` deletes a project's transcripts.

---

## 2. Headless I/O, stream-json events, and resume

### 2.1 Invocation patterns

```bash
# Simplest: text result on stdout
claude -p "Explain src/auth.ts"

# Single JSON result object
claude -p "Summarize this project" --output-format json | jq -r '.result'

# Structured output
claude -p "List exported functions in src/auth.ts" --output-format json \
  --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}' \
  | jq '.structured_output'

# Live progress (what the factory should use); prompt on stdin
printf '%s' "$PROMPT" | claude -p --output-format stream-json --verbose --include-partial-messages \
  --session-id "$UUID" --permission-mode dontAsk --permission-prompts none \
  --settings /path/to/factory-settings.json --max-turns 80 --max-budget-usd 20
```

Exit status: 0 on success, non-zero on failure. Invalid flags go to stderr before the run starts. Failures inside the run (for example missing auth) are printed **as the result on stdout** [docs]. SIGTERM gives exit **143** and leaves the current turn unrecorded. **SIGINT ends the turn cleanly** [docs]. Piped stdin is capped at **10 MB** [docs].

After the final turn the process may keep running to wait for background work (background Bash, background subagents, Monitor). The idle cap is 10 minutes by default, configurable with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` [docs]. Setting `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` makes runs end deterministically. If your reader is slow, Claude Code waits up to 30 s for stdout to drain [docs], so always consume stdout.

### 2.2 Event shapes

Each line of stdout is one JSON object. The examples below are trimmed from the real smoke-test output [local] unless marked.

**`system/init`** is the first line, unless `SessionStart`/`Setup` hook events or `plugin_install` events come before it [docs]:

```json
{"type":"system","subtype":"init","cwd":"/private/tmp/cc-smoke","session_id":"0b6f2c1e-8d4a-4f3b-9e2a-5c7d1a3e9f40",
 "tools":["Bash","Edit","Read","Write","WebFetch","WebSearch","Task","Skill","NotebookEdit","Monitor","ToolSearch","EnterWorktree","ExitWorktree","…27 total"],
 "mcp_servers":[],"model":"claude-opus-5-5","permissionMode":"default","slash_commands":["…71…"],
 "apiKeySource":"none","claude_code_version":"2.1.314","output_style":"default",
 "agents":["claude","Explore","general-purpose","…"],"skills":["…35…"],"plugins":[{"name":"frontend-design","path":"…","source":"…","version":"1.1.1"}],
 "capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","interrupt_send_now_v1","interrupt_requeue_taken_v1","msg_lifecycle_v1","request_marker_lists_v1"],
 "memory_paths":{"auto":"/Users/me/.claude/projects/-private-tmp-cc-smoke/memory/"},
 "additional_directories":["/tmp/cc-smoke"],"fast_mode_state":"off","uuid":"…"}
```

This trivial run loaded 35 skills, 6 agents, 4 plugins and 71 slash commands from the **user's** interactive config. That is why §6 recommends an isolated config.

The documented optional fields `plugin_errors` and `mcp_server_errors` are present only when non-empty. Fail the run when either is non-empty [docs].

**`system/status`** [local]:

```json
{"type":"system","subtype":"status","status":"requesting","session_id":"…","uuid":"…"}
```

**`stream_event`** lines appear only with `--include-partial-messages`. They wrap raw Messages-API stream events [local]:

```json
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-5-5","id":"msg_…","usage":{"input_tokens":2,"cache_creation_input_tokens":9187,"cache_read_input_tokens":11382,"output_tokens":4}}},"session_id":"…","parent_tool_use_id":null,"ttft_ms":2220}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}},"session_id":"…","parent_tool_use_id":null}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4,"output_tokens_details":{"thinking_tokens":0}}}}
{"type":"stream_event","event":{"type":"message_stop"}}
```

**`assistant`** carries a complete Messages-API message [local]:

```json
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_…","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"…":"…"}},
 "parent_tool_use_id":null,"session_id":"…","uuid":"…","timestamp":"2026-10-31T06:01:44.854Z","request_id":"req_…"}
```

A tool call appears as a `content` block `{"type":"tool_use","id":"toolu_…","name":"Bash","input":{"command":"npm test","description":"…"}}`. Several `assistant` lines can share one `message.id` (parallel tool calls). Deduplicate usage by id. Per-message `output_tokens` is a placeholder; read the real output count from `result` [docs].

**`user` / tool results** (shape from the SDK's `SDKUserMessage` type and the Messages API; not exercised by the smoke test):

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_…","content":"…","is_error":false}]},
 "parent_tool_use_id":null,"session_id":"…","uuid":"…","tool_use_result":{"…tool-specific…":"…"}}
```

`parent_tool_use_id` is non-null for subagent and forked-skill messages [docs].

**`rate_limit_event`** is subscription telemetry. It is not mentioned on the headless page but is in the SDK message union [docs] and was emitted once per request [local]:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793437200,"rateLimitType":"five_hour",
 "overageStatus":"rejected","overageDisabledReason":"…","isUsingOverage":false,
 "unifiedWindows":{"five_hour":{"utilization":"…","resetsAt":1793437200,"status":"allowed"},
                   "seven_day":{"utilization":"…","resetsAt":1793444400,"status":"allowed"}}},
 "uuid":"…","session_id":"…"}
```

**Other `system` subtypes** [docs]:

- `api_retry`, with fields `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, and `error`. `error` is one of `authentication_failed`, `rate_limit`, `overloaded`, `billing_error`, `server_error`, …
- `permission_denied`, with fields `tool_name`, `tool_use_id`, `decision_reason`, and `message`.
- `compact_boundary`.
- `hook_started`, `hook_progress`, and `hook_response`.
- `plugin_install`.

**`result`** is the last line, and the same object that `--output-format json` prints. This is the full real output, with ids shortened [local]:

```json
{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"result":"ok","stop_reason":"end_turn","terminal_reason":"completed",
 "session_id":"0b6f2c1e-8d4a-4f3b-9e2a-5c7d1a3e9f40","num_turns":1,"duration_ms":2379,"duration_api_ms":2241,"ttft_ms":2357,
 "total_cost_usd":0.0758604,
 "usage":{"input_tokens":2,"cache_creation_input_tokens":9187,"cache_read_input_tokens":11382,"output_tokens":4,
          "output_tokens_details":{"thinking_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},
          "service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":9187,"ephemeral_5m_input_tokens":0},
          "inference_geo":"global","iterations":[{"…":"…"}],"speed":"standard","fallback_credit":null},
 "modelUsage":{"claude-opus-5-5":{"inputTokens":2,"outputTokens":4,"cacheReadInputTokens":11382,"cacheCreationInputTokens":9187,
          "webSearchRequests":0,"costUSD":0.0758604,"contextWindow":1000000,"maxOutputTokens":128000,"thinkingTokens":0,
          "cacheCreationEphemeral5mInputTokens":0,"cacheCreationEphemeral1hInputTokens":9187,
          "canonicalModel":"claude-opus-5-5","provider":"firstParty","costBasis":"list"}},
 "model_usage_since_last_result":{"claude-opus-5-5":{"…same shape…":0}},
 "permission_denials":[],
 "subagent_stats":{"spawned":0,"completed":0,"failed":0,"max_depth":0,"killed":{"parent":0,"user":0,"system":0},
                   "refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},
 "safety_stops":0,"fast_mode_state":"off","queued_turn_count":0,"result_index":0,"uuid":"…"}
```

The documented result union, `SDKResultMessage`, also defines these fields [docs]:

- `subtype` is one of `success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, or `error_max_structured_output_retries`.
- `errors: string[]` (on the error subtypes).
- `structured_output` (only when `--json-schema` succeeded; check that it is present).
- `deferred_tool_use` (when a PreToolUse hook returned `defer`; see §3.3).
- `startup_failure_reason`. Examples are `worktree_resume_refused` and `worktree_unverified`.

`model_usage_since_last_result`, `subagent_stats`, `safety_stops` and `terminal_reason` appeared in the real output. Only `terminal_reason` is in the documented type [local vs docs].

### 2.3 Parsing stdout line by line (Node 25)

```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("/Users/me/.local/bin/claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
child.stdin.end(prompt);                                    // prompt on stdin (≤10 MB)
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let ev: any;
  try { ev = JSON.parse(line); } catch { log.warn("non-JSON stdout", line); continue; }
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") { if (ev.apiKeySource !== "none") abort("not using subscription"); onSession(ev.session_id); }
      else if (ev.subtype === "api_retry") onRetry(ev);
      else if (ev.subtype === "permission_denied") onDenied(ev);
      break;
    case "stream_event":
      if (ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") onDelta(ev.event.delta.text);
      break;
    case "assistant":
      for (const b of ev.message.content) {
        if (b.type === "text") onText(b.text, ev.parent_tool_use_id);
        else if (b.type === "tool_use") onToolCall(b.id, b.name, b.input, ev.parent_tool_use_id);
      }
      break;
    case "user":
      if (Array.isArray(ev.message?.content))
        for (const b of ev.message.content) if (b.type === "tool_result") onToolResult(b.tool_use_id, !!b.is_error, b.content);
      break;
    case "rate_limit_event": onRateLimit(ev.rate_limit_info); break;
    case "result": onResult(ev); break;
    default: onUnknown(ev);                                  // forward-compatible: new types appear often
  }
}
```

### 2.4 Follow-up feedback ("the reviewer said X, fix it")

```bash
# First run: pre-assign the id so the DB row exists before the process starts
claude -p --session-id 7d1c…-uuid --output-format stream-json --verbose … < task.md
# Follow-up run, same transcript and context; same session_id comes back unless --fork-session is added
printf 'Code review feedback:\n- %s\nAddress every point, rerun the tests, then summarise.\n' "$X" \
  | claude -p --resume 7d1c…-uuid --output-format stream-json --verbose --permission-mode dontAsk --permission-prompts none --settings …
```

Notes on resuming:

- **Where transcripts live.** Transcripts are stored at `~/.claude/projects/<encoded cwd>/<session-id>.jsonl`. For example, `/private/tmp/cc-smoke` is encoded as `-private-tmp-cc-smoke` [local]. `--resume` finds the session by id from any directory [docs]. The factory should still resume from the same worktree so file context matches.
- **What a resumed run reports.** `total_cost_usd` and `modelUsage` report the **whole conversation's** total, including earlier runs (v2.1.277+). Store the previous total and take the difference [docs]. The undocumented `model_usage_since_last_result` field may provide that delta directly [local, unverified semantics].
- **What carries over.** The system prompt text from the first run is reused because of the snapshot [docs]. Flags (permissions, settings, MCP) must be passed again on every invocation.
- **What breaks resume.** Do not use `--no-session-persistence` or `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` for tasks that may need a follow-up. Transcripts older than `cleanupPeriodDays` (default 30) are deleted at startup [docs]. Raise that value in the factory settings, or archive the `.jsonl` yourself.
- **Inherited child-session marker.** An inherited `CLAUDE_CODE_CHILD_SESSION=1` excludes nested *interactive* sessions from resume. "Non-interactive `claude -p` sessions still persist" [docs].
- **Long-lived alternative.** Keep one process open with `--input-format stream-json --output-format stream-json --verbose`. Write one JSON line per user turn: `{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}`. That shape comes from the SDK's `SDKUserMessage` type; the exact CLI stdin contract is [unverified]. Each turn emits its own `result`, and `total_cost_usd` is cumulative across them [docs]. Closing stdin ends the session.

---

## 3. Permissions in non-interactive mode

### 3.1 What happens with no TTY

Since v2.1.302, a `-p` run that has no permission mode set starts in **Manual** mode (`default`). A call that needs approval is **denied** unless something resolves it. The things that can resolve it are allow rules, a `PreToolUse` or `PermissionRequest` hook, the SDK's `canUseTool`, or `--permission-prompt-tool` [docs].

The run does not hang. Claude is told the call was denied and carries on. Denials are reported in three places [docs]:

- `system/permission_denied` events, in stream-json output.
- `result.permission_denials`: an array of `{tool_name, tool_use_id, tool_input}`.
- Indirectly, through Claude's own text.

Some calls are denied even when an allow rule matches:

- `AskUserQuestion`, and `ExitPlanMode` in plan mode, are only offered in `-p` when a permission host exists [docs].
- Recognized `rm`/`rmdir` critical-path removals.
- Reads from network paths.

Rule evaluation order is **deny → ask → allow**, and the first match wins. A deny rule cannot be overridden by a more specific allow rule [docs].

Modes, as they behave in `-p` [docs]:

| Mode | Runs without asking | Factory use |
|---|---|---|
| `default` / `manual` | Reads and the built-in read-only Bash set (`ls`, `cat`, `grep`, `find`, `git` read forms, …) | Not useful alone. Everything else is denied. |
| `acceptEdits` | Reads, file edits, `mkdir`/`touch`/`mv`/`cp` | Implementation runs, together with `--allowedTools` for build and test commands |
| `dontAsk` | Reads, plus anything matching allow rules or approved by a PreToolUse hook; everything else is denied, with no host consulted | **Recommended**: deterministic and allowlist-driven |
| `plan` | Read-only. Plan-mode blocks hold in `-p`. Shell commands may go to the auto-mode classifier | Planning or analysis runs |
| `auto` | A classifier (Claude Sonnet 5 by default) reviews each action. A bare `Bash` allow rule is dropped | Unattended runs where an allowlist is impractical. Costs extra tokens. Pair with `--permission-prompts none` |
| `bypassPermissions` | Everything except "actions no mode auto-approves". Deny rules still apply | Only inside a disposable VM or container. Refused as root or under sudo. **Not on the host Mac.** |

Recommended flags for an implementation run:

```bash
--permission-mode dontAsk --permission-prompts none --settings "$FACTORY_SETTINGS"
# or: --permission-mode acceptEdits --permission-prompts none --allowedTools=Bash(npm test *),Bash(npm run *),Bash(git commit *)
```

Bash rule syntax notes [docs]:

- `Bash(git log *)` matches `git log …`. The space before `*` matters: `Bash(git diff*)` also matches `git diff-index`.
- Compound commands (`&&`, `||`, `;`, `|`, `&`) need **every** subcommand to be allowed.
- Wrappers `timeout`, `time`, `nice`, `nohup` and `stdbuf` are stripped before matching.
- Path rules follow gitignore syntax. `//abs/path` is absolute, `~/…` is relative to home, `/x` is relative to the settings source, and `./x` or `x` is relative to the cwd.
- `WebFetch(domain:example.com)`, `mcp__server__tool`, `mcp__server__*` and `Agent(Explore)` are also valid rules.

### 3.2 Hooks: the guardrail mechanism

Where hooks are configured:

- `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed settings, `--settings`.
- Plugin `hooks/hooks.json`.
- Skill or subagent frontmatter [docs].

Structure: event → matcher group → handlers. Handler `type` is `command`, `http`, `mcp_tool`, `prompt` or `agent` [docs]. The field-level schema of `http` hooks was not read [unverified].

**Events.** Lifecycle and turn control [docs]:

- `SessionStart` (matcher on `startup`/`resume`/`clear`/`compact`/`fork`): can add context, or set `initialUserMessage` in `-p`.
- `Setup` (`--init` or `--maintenance`).
- `UserPromptSubmit` and `UserPromptExpansion`: can block.
- `Stop` and `SubagentStop`: block to keep the agent working.
- `StopFailure` (API error).
- `SessionEnd`, with reason `clear`/`resume`/`logout`/`prompt_input_exit`/`other`. Default timeout 1.5 s.

Tool and permission events [docs]:

- `PreToolUse`: can block, allow, ask, defer, or rewrite the input.
- `PermissionRequest`: can allow or deny with a `decision` object. Exit 2 is ignored for this event.
- `PermissionDenied` (auto mode).
- `PostToolUse`: can add context or replace the output Claude sees; it cannot undo the call.
- `PostToolUseFailure`.
- `PostToolBatch`: can stop the loop.

Other events [docs]:

- `Notification` (matchers `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_*`, `quota_auto_resume_*`, …).
- `SubagentStart`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`.
- `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`.
- `WorktreeCreate`, `WorktreeRemove`.
- `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`.
- `Elicitation`, `ElicitationResult`, `MessageDisplay`.

**Matchers** [docs]:

| Matcher | How it matches |
|---|---|
| `"*"`, `""` or omitted | Everything |
| Letters, digits, `_`, `-`, `,`, `\|`, space only | Exact name, or a list (`Edit\|Write`) |
| Anything else | Unanchored JS regex (`mcp__memory__.*`) |

The handler field `"if": "Bash(rm *)"` filters further using permission-rule syntax.

**stdin JSON**, common fields [docs]: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort`, `hook_event_name`. Inside subagents, `agent_id` and `agent_type` are added. Per-event fields:

- `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`.
- `PostToolUse`: adds `tool_response` and `duration_ms`.
- `Stop`: `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`.

**Exit codes** [docs]:

| Code | Effect |
|---|---|
| `0` | Success. JSON on stdout is applied. Plain stdout becomes context only for `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart` and `PostModelSwitch`. |
| `2` | Blocking error on events that can block. **stderr is the reason Claude sees.** Exit 2 blocks even if the JSON says allow. |
| Other | Non-blocking error; the action proceeds. **Exit 1 does not block.** |

**JSON output** [docs]:

- Universal fields: `continue` (false stops the agent), `stopReason`, `systemMessage`, `suppressOutput`.
- `PreToolUse`: `hookSpecificOutput: {hookEventName:"PreToolUse", permissionDecision:"allow"|"deny"|"ask"|"defer", permissionDecisionReason, updatedInput, additionalContext}`.
- `PostToolUse`, `Stop` and others: top-level `{"decision":"block","reason":"…"}`.
- `PermissionRequest`: `hookSpecificOutput.decision: {behavior:"allow"|"deny", updatedInput?, updatedPermissions?, message?, interrupt?}`.
- Strings are capped at 10,000 characters.

**Precedence.** A PreToolUse `allow` does not bypass deny or ask rules. A hook that exits 2 blocks before any rules are evaluated [docs].

**Hooks and `-p`** [docs]:

- Repo hooks run in `-p` without any trust prompt.
- `--settings '{"disableAllHooks": true}'` turns them off. Setting it in user settings is not enough, because project settings can override it.
- Async hooks (`"async": true`) are killed at teardown of a `-p` run.
- The env var `CLAUDE_PROJECT_DIR` (and `${CLAUDE_PROJECT_DIR}` in commands) is the project root where the session started. The `cwd` field follows Claude into worktrees.
- `CLAUDE_ENV_FILE` is available to SessionStart, Setup, CwdChanged and FileChanged hooks for persisting env exports.

**Stop-hook loops.** Claude Code applies an 8-consecutive-continuation cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Check `stop_hook_active` to avoid blocking forever [docs].

### 3.3 `defer`: pause for a human or external approval

A `PreToolUse` hook that returns `permissionDecision: "defer"` is honored **only in `-p`** [docs]:

- The turn ends with `stop_reason: "tool_deferred"`.
- The result carries `deferred_tool_use: {id, name, input}`.
- The factory can show that to a person, then run `claude -p --resume <id> …`.

This is the cleanest "approve `git push` from Slack" primitive available without the SDK.

### 3.4 `--permission-prompt-tool` (hidden flag, documented)

`claude -p --mcp-config ./mcp.json --permission-prompt-tool mcp__permissions__approve "…"` [docs]:

- The tool is consulted only for calls that would otherwise prompt.
- Claude Code waits up to `MCP_TIMEOUT` for the tool's server to connect.
- It can't approve MCP tools marked `requiresUserInteraction`: an `allow` for one is converted to a deny.
- `--permission-prompts none` skips the tool entirely.

The tool's contract is **not fully specified in the docs** [unverified]. Community implementations, and the mirrored SDK `PermissionResult`, use these shapes:

- Input: `{ tool_name, input, tool_use_id? }`.
- Output: a single **text** content block containing JSON, either `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}`.

Before v2.1.207, an `allow` without `updatedInput` was rejected [docs, SDK page]. Always echo the input back. An invalid reply is treated as a deny [unverified].

For the factory, a `PreToolUse` hook (command or http) is simpler and better documented than this flag.

### 3.5 Guard hook examples (Node, no jq)

`.claude/hooks/guard-bash.mjs` (run `chmod +x` on it):

```js
#!/usr/bin/env node
// PreToolUse(Bash): deny destructive commands. JSON deny + exit 0 (documented); exit 2 + stderr also works.
import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
const cmd = String(input.tool_input?.command ?? "");
const rules = [
  [/\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\b/i, "recursive force delete"],
  [/\bgit\s+push\b/, "the factory pushes, not the agent"],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s)/, "destructive git operation"],
  [/\b(sudo|mkfs|shutdown|reboot)\b|\bdd\s+if=/, "privileged/destructive command"],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, "pipe-to-shell"],
];
for (const [re, why] of rules) if (re.test(cmd)) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: `Blocked by factory policy: ${why}` } }));
  process.exit(0);
}
process.exit(0);
```

`.claude/hooks/require-tests.mjs` (Stop):

```js
#!/usr/bin/env node
// Stop: if the tree changed and tests fail, keep Claude working. One retry, then let it stop (the factory re-verifies).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const input = JSON.parse(readFileSync(0, "utf8"));
if (input.stop_hook_active) process.exit(0);
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: input.cwd, encoding: "utf8" }).stdout.trim();
if (!dirty) process.exit(0);
const r = spawnSync("npm", ["test", "--silent"], { cwd: input.cwd, encoding: "utf8", timeout: 540_000 });
if (r.status === 0) process.exit(0);
const tail = `${r.stdout}\n${r.stderr}`.split("\n").slice(-80).join("\n");
process.stdout.write(JSON.stringify({ decision: "block", reason: `Tests fail. Fix them before finishing:\n${tail}` }));
```

Matching config (exec form, as in the docs):

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-bash.mjs", "args": [], "timeout": 10 }] }],
    "Stop":       [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/require-tests.mjs", "args": [], "timeout": 600 }] }]
  }
}
```

Debugging: use `claude -p --debug-file /tmp/hooks.log --debug=hooks …`. The full log goes to `~/.claude/debug/<session-id>.txt` [docs].

---

## 4. Project configuration the factory can write into a repo

The files below are what Claude Code reads from a repo. One `-p`-specific caveat applies (verified in [docs]). When Claude runs in a folder that was never trusted interactively:

| Content | Status in `-p` |
|---|---|
| **Hooks** and **`env`** from `.claude/settings.json` | **Used** |
| `deny` and `ask` rules | **Used** |
| `.mcp.json` servers | **Connected without asking** |
| Project skills' `allowed-tools` | **Used** |
| **`permissions.allow`** and `additionalDirectories` from `.claude/settings.json` | **Ignored**, with a stderr warning |
| Frontmatter hooks and inline `mcpServers` in project **subagents** | **Ignored** |

You can trust a folder by hand by setting `projects["<repo root>"].hasTrustDialogAccepted = true` in `~/.claude.json` [docs]. Writing that shared file from parallel runs is risky [unverified]. **Recommendation:**

- Keep allow rules and the guard hooks in a factory-owned settings file passed with `--settings` (command-line layer, above project). It also wins over a repo's `disableAllHooks`: the docs use `--settings '{"disableAllHooks": true}'` to override project settings, so by the same precedence `"disableAllHooks": false` there should beat a repo's `true` [docs, by precedence]. That `--settings` content is not gated by trust is an inference: the trust table lists only repository-supplied content [unverified].
- Write only repo-specific knowledge into the repo: CLAUDE.md, rules, agents and skills.

Always add `.claude/settings.local.json`, `CLAUDE.local.md` and `.claude/worktrees/` to `.gitignore`.

### 4.1 `CLAUDE.md`

Plain Markdown, loaded every session [docs].

- **Load order:**
  1. Managed (`/Library/Application Support/ClaudeCode/CLAUDE.md`).
  2. User (`~/.claude/CLAUDE.md`).
  3. Project (`./CLAUDE.md` or `./.claude/CLAUDE.md`).
  4. Local (`./CLAUDE.local.md`).
- **Discovery:** files from the cwd and every parent directory are concatenated, root first. Subdirectory CLAUDE.md files load lazily when Claude touches files there.
- **Imports:** `@path/to/file`, relative to the importing file, up to 4 hops deep.
- **Size:** aim for **under 200 lines** per file.
- **AGENTS.md:** read *instead* when no CLAUDE.md or CLAUDE.local.md exists in the cwd or above it (v2.1.277+). To share one file across agents, put `@AGENTS.md` in CLAUDE.md.
- **Turning it off:** `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`.
- **`--add-dir` directories:** their CLAUDE.md only loads with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.

CLAUDE.md is guidance, not enforcement. Use hooks and permissions for anything that must hold [docs].

Suggested factory template:

```markdown
# Project instructions
## Commands
- Install: `npm ci` · Build: `npm run build` · Test: `npm test` · Lint: `npm run lint`
## Conventions
- TypeScript strict; no `any` in new code. Follow existing patterns in `src/`.
## Workflow rules (factory)
- Work only inside this checkout. Never push, never change remotes, never edit CI secrets.
- Run `npm test` and `npm run lint` before finishing; report anything you could not fix.
- Commit with a conventional-commit message when the task is complete.
@AGENTS.md
```

### 4.2 `.claude/rules/*.md`

These are path-scoped instruction files. `paths` is the only frontmatter key that is read. A rule without `paths` always loads [docs].

```markdown
---
paths:
  - "src/api/**/*.ts"
---
- Every endpoint validates input with zod and returns the standard error envelope.
```

### 4.3 `.claude/settings.json`

The precedence stack, highest first: managed > `--settings` (command line) > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`. List keys such as `permissions.allow` **merge** across levels [docs]. `defaultMode` values `auto` and `bypassPermissions` are not honored from project or local files [docs].

Example factory settings file, shown here for passing via `--settings` (the same keys work in `.claude/settings.json`). The files must be strict JSON with no comments:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "Read", "Edit", "Write",
      "Bash(npm ci)", "Bash(npm test *)", "Bash(npm test)", "Bash(npm run *)", "Bash(npx tsc *)",
      "Bash(git status *)", "Bash(git diff *)", "Bash(git log *)", "Bash(git add *)", "Bash(git commit *)"
    ],
    "deny": [
      "Bash(git push *)", "Bash(git remote *)", "Bash(sudo *)",
      "Read(./.env)", "Read(./.env.*)", "Edit(./.github/workflows/**)",
      "WebSearch"
    ]
  },
  "disableAllHooks": false,
  "cleanupPeriodDays": 365,
  "hooks": { "…": "see §3.5" }
}
```

### 4.4 `.claude/agents/<name>.md` (subagents)

Markdown with YAML frontmatter; the body is the system prompt. Only `name` and `description` are required [docs]. Frontmatter fields:

- Core: `name`, `description`, `tools`, `disallowedTools`.
- Model: `model` (`sonnet`, `opus`, `haiku`, `fable`, a full id, or `inherit`), `effort`.
- Behaviour: `permissionMode`, `maxTurns`, `autoCompactWindow`, `background`, `isolation: worktree`, `initialPrompt`.
- Context: `skills`, `memory` (`user`/`project`/`local`), `omitClaudeMd`.
- Integrations: `mcpServers`, `hooks`.
- Display and other: `color`, `experimental`.

Lookup order and runtime behaviour [docs]:

- Priority: managed > `--agents` > `.claude/agents/` > `~/.claude/agents/` > plugin.
- Identity comes from `name`, not the filename.
- The subagent tool is `Agent`. It appears as `Task` in the 2.1.314 init tool list [local]; `Task(...)` still works.
- Nesting depth defaults to 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`) and concurrency to 20 (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).
- Subagents spawned from the main conversation start in the background by default (fork mode). `CLAUDE_CODE_FORK_SUBAGENT=0` turns that off.

```markdown
---
name: test-fixer
description: Runs the test suite, diagnoses failures and fixes them. Use after code changes.
tools: Read, Edit, Bash
model: sonnet
maxTurns: 30
---
Run `npm test`. For each failure, find the root cause, fix the code (not the test, unless the test is wrong), and rerun until green.
```

The same agents can be passed per run as JSON with `--agents ./agents.json` in print mode. The format is `{"name": {"description","prompt","tools","model",…}}` [local + docs].

### 4.5 `.claude/skills/<name>/SKILL.md` and `.claude/commands/<name>.md`

Commands have been merged into skills. `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both create `/deploy`; when both exist, the skill wins. Subdirectories give namespaced names: `commands/frontend/component.md` becomes `/frontend:component` [docs].

Skill frontmatter fields:

- Identity and discovery: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `paths`.
- Who can invoke it: `disable-model-invocation`, `user-invocable`.
- Tools: `allowed-tools`, `disallowed-tools`.
- Model and execution: `model`, `effort`, `context: fork`, `agent`, `background`, `shell`.
- `hooks`.

Substitutions and dynamic content:

- Arguments: `$ARGUMENTS`, `$0`, `$1`, …, or `$name`.
- Paths and ids: `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`.
- `` !`cmd` `` runs a shell command before the skill text is sent and inlines its output [docs].

In `-p`, put `/skill-name args` in the prompt. Only the first skill on the line is expanded [docs].

```markdown
---
name: address-review
description: Apply code-review feedback to the current branch
argument-hint: "[review text]"
allowed-tools: Read, Edit, Bash(npm test *)
---
## Current diff
!`git diff --stat HEAD~1`

Apply this review feedback, rerun tests, and summarise each point as done / not done:
$ARGUMENTS
```

### 4.6 `.mcp.json` (project MCP servers)

```json
{ "mcpServers": {
    "issues": { "type": "http", "url": "${ISSUES_URL:-http://127.0.0.1:7801}/mcp", "headers": { "Authorization": "Bearer ${ISSUES_TOKEN}" } },
    "local-tool": { "command": "node", "args": ["./tools/mcp.js"], "env": { "LOG": "1" } } } }
```

Supported types are stdio (the default when `type` is absent), `http`, `sse` (deprecated) and `ws`. An entry with a `url` but no `type` is an error [docs]. In `-p`, `.mcp.json` servers connect **without approval** [docs]. For the factory, prefer `--strict-mcp-config --mcp-config=/factory/mcp.json` so a repo cannot inject servers. The `--mcp-config` file takes the same `{"mcpServers":{…}}` shape [docs show the flag only; the shape is unverified from the docs excerpt]. MCP tool output warns at 10k tokens and is capped at 25k (`MAX_MCP_OUTPUT_TOKENS`) [docs].

---

## 5. Cost and usage accounting with a subscription login

**What the numbers mean.**

- `total_cost_usd` and `modelUsage[*].costUSD` are **client-side estimates at list price**, computed from a bundled price table. The smoke test reported `costBasis: "list"`, `apiKeySource: "none"` and `provider: "firstParty"` [local]. The docs say these "can differ from your bill" and should not be used for billing [docs].
- Subscribers are not billed per token. The `/usage` Session block "isn't relevant for billing purposes" for Pro, Max and Ultra [docs].
- Use the USD figure as a **relative consumption gauge** and as the input to `--max-budget-usd`, which still works as a runaway guard.
- Account primarily in tokens: `modelUsage` covers subagents too, while `usage` covers the main loop only [docs].
- For calibration, the smoke test's "Reply with exactly: ok" cost about $0.076 at list price. Almost all of that was cold-start context (~20.5k input tokens: 9.2k cache write with a 1 h TTL, 11.4k cache read) on Opus 5.5 [local]. Every fresh `-p` session pays this overhead, and more if the user config loads many skills and plugins. Resuming within the cache TTL is cheaper.
- On a subscription, your own turns get the **1-hour** cache TTL automatically, dropping to 5 minutes once you draw on usage credits [docs].

**Plan limits** (support.claude.com, 2026-10):

- Pro and Max have a **five-hour session limit and a weekly limit**. Max and Ultra also have a **separate weekly limit for Fable**.
- Verified Ultra accounts have no five-hour limit.
- Limits are **shared between claude.ai and Claude Code**.
- Max provides 5× Pro usage. The former "Max 20x" tier is now called Ultra. Exact token or message quotas are not published [unverified beyond the articles].
- When a limit is hit, the CLI messages are "You've hit your session limit", "… weekly limit", "… Opus limit" or "… Sonnet limit". Options are usage credits (`/usage-credits`), waiting, or (an anti-goal here) an API key [docs].

**How to observe usage headlessly:**

1. **`rate_limit_event`** lines in stream-json, with `status`, `rateLimitType`, `resetsAt` (epoch seconds), `isUsingOverage`, and `unifiedWindows.{five_hour,seven_day}.{utilization (0–1), resetsAt, status}` [local]. **This is the best signal.** Persist the latest event per account, stop dispatching new runs above a threshold (for example 0.85 of the five-hour window), and schedule a resume at `resetsAt`.
2. `system/api_retry` with `error: "rate_limit"` and `error_status: 429` [docs].
3. A result with `is_error: true`, `api_error_status: 429`, or limit text in `result` [docs say limit messages land in `result` for json and stream-json; exact strings unverified].
4. `claude auth status --json` gives `subscriptionType` without spending quota [local].
5. Interactive `/usage` (plan bars plus a breakdown) and `/status` [docs]. Whether `/usage` prints anything useful in `-p` is [unverified].
6. `CLAUDE_CODE_RETRY_WATCHDOG=1` retries 429 and 529 errors indefinitely in unattended runs. With it set, a request waits for a usage limit to reset [docs]. Use it only if the factory prefers blocking to failing.

A `claude setup-token` token (`CLAUDE_CODE_OAUTH_TOKEN`, valid one year) authenticates with the subscription but carries only `user:inference`. Plan-usage data needs the `user:profile` scope of a normal `/login` [docs]. Whether `rate_limit_event` still arrives under such a token is [unverified]. Prefer the keychain login for the factory.

---

## 6. Isolation: worktrees, concurrency, environment

### 6.1 Concurrent sessions on one repo

The factory should manage worktrees itself:

```bash
git -C /repos/app fetch origin
git -C /repos/app worktree add /work/app/task-123 -b factory/task-123 origin/main
# spawn claude with cwd=/work/app/task-123 ; afterwards:
git -C /repos/app worktree remove /work/app/task-123   # add --force if dirty; `git worktree unlock` first if locked
```

Why not `claude -p --worktree <name>` [docs]:

- It is forced to `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`.
- It branches from `origin/HEAD`, with a ≤5 s fetch, unless `worktree.baseRef: "head"` is set.
- It **does not clean up in `-p` mode** and leaves a `git worktree lock` behind.
- It skips repo-local git filter drivers (Git LFS installed with `--local`).
- A `.worktreeinclude` file (gitignore syntax) copies ignored files such as `.env` into the worktree.

What worktrees share with the main checkout [docs]:

- The `.git` directory.
- The main checkout's `.claude/settings.local.json`. Permission approvals written there apply to all worktrees.
- Untracked `.claude/skills`, `agents` and `commands` from the main checkout are read through when the worktree has none.
- Auto memory, which is per repository and shared across worktrees.
- Sessions are recorded per cwd, so each worktree gets its own transcript directory [local/docs].

Inside a worktree session, Claude Code blocks edits to the main checkout and commands that run git there [docs].

Each worktree is a fresh checkout, so the factory must run `npm ci` or the equivalent before or during the task.

Concurrency limits to consider:

- Subscription rate limits are shared by all runs (§5).
- Many simultaneous sessions write `~/.claude.json` and the projects dir [unverified risk]. A small concurrency cap (2–4) is sensible on one subscription seat.

### 6.2 Keeping the child away from your interactive config

| Option | Effect | Verdict |
|---|---|---|
| **Dedicated `CLAUDE_CONFIG_DIR`** (e.g. `~/.software-factory/claude`), logged in once with `CLAUDE_CONFIG_DIR=… claude auth login` | Separate settings, plugins, skills, agents, MCP, history **and a separate claude.ai login** (the keychain entry is keyed to the directory) [docs] | **Recommended.** Clean and deterministic, and it still uses your subscription. Not tested here [unverified in practice]. |
| `--setting-sources project,local` + `--strict-mcp-config` + `--settings <factory.json>` | Skips `~/.claude/settings.json` and user MCP servers | Good second layer. Whether user-level CLAUDE.md, skills, agents and plugins are also skipped is [unverified]. |
| `--bare` / `CLAUDE_CODE_SIMPLE=1` | Skips everything **and the OAuth login** | **Unusable** without an API key. |
| `--safe-mode` | Skips user **and project** customizations | Defeats repo configuration. |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | Stops auto-memory reads and writes | Recommended for reproducible runs. |

### 6.3 Environment variables

**Scrub these from the child; never inherit them** [docs unless noted]:

| Variable | Why |
|---|---|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | An API key or token overrides the subscription; in `-p` an API key is always used when present. A base URL reroutes traffic. |
| `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` | Cloud providers rank first in auth precedence. |
| `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` | Silently change models. `ANTHROPIC_MODEL` beats the settings file; `--model` beats it. |
| `CLAUDE_CODE_EFFORT_LEVEL` | Overrides `--effort`. |
| `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_SAFE_MODE` | Turn on bare or safe mode. |
| `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_CODE_BRIDGE_*`, `CLAUDE_CODE_WORKER_EPOCH`, `CLAUDE_CODE_ENVIRONMENT_KIND` | Present when the factory itself is launched from a Claude Code session [local]. Most are undocumented internals. |

**Variables the factory may set deliberately:**

| Variable | Purpose |
|---|---|
| `CLAUDE_CONFIG_DIR` | Isolated profile (§6.2) |
| `DISABLE_AUTOUPDATER=1` | Pin the binary; update deliberately (`DISABLE_UPDATES` blocks manual updates too) |
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` | Quieter runs |
| `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1` | Optional. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` also disables **feature-flag fetching**, which some features need; even `=0` disables it |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | Reproducibility |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | `-p` ends when the turn ends |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` | Otherwise, cap the wait for background work |
| `BASH_DEFAULT_TIMEOUT_MS` (default 120000), `BASH_MAX_TIMEOUT_MS` (default 600000), `BASH_MAX_OUTPUT_LENGTH` (default 30000) | Long test suites |
| `MCP_TIMEOUT` (startup, default 30000), `MCP_TOOL_TIMEOUT`, `MAX_MCP_OUTPUT_TOKENS` | MCP limits |
| `MAX_THINKING_TOKENS` | Fixed-budget models only. Adaptive models ignore non-zero values; use `--effort` |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Output cap |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_FORK_SUBAGENT` | Subagent fan-out |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` | Stop-hook loop cap |
| `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` | Continue a turn killed by SIGTERM when resuming |
| `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1` | Same as `--forward-subagent-text` |
| `CLAUDE_CODE_TMPDIR`, `CLAUDE_CODE_SHELL` (bash/zsh path), `CLAUDE_ENV_FILE` | Shell environment for the Bash tool |
| `CLAUDE_CODE_RETRY_WATCHDOG=1` | Wait out 429s (§5) |
| `DISABLE_AUTO_COMPACT=1`, `DISABLE_PROMPT_CACHING=1` | Rarely wanted |
| `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` | Only if an inherited child-session marker suppresses persistence |

Claude Code also **sets** variables for the processes it spawns. `CLAUDECODE=1` and `CLAUDE_CODE_CHILD_SESSION=1` go to Bash commands and hooks. Hooks additionally get `CLAUDE_PROJECT_DIR` and `CLAUDE_EFFORT` [docs]. Test scripts can use these to detect that they are running under Claude.

macOS note: the claude.ai login lives in the **Keychain**. If the Keychain is locked, for example over SSH, Claude Code falls back to `~/.claude/.credentials.json` (mode 0600) [docs]. Run the factory as a LaunchAgent inside your login session, not as a LaunchDaemon [unverified, but follows from the Keychain model].

---

## 7. The TypeScript Agent SDK (`@anthropic-ai/claude-agent-sdk`)

**Facts** [docs, plus `npm view` for the version]:

- Install with `npm install @anthropic-ai/claude-agent-sdk`. Latest on npm is **0.3.316** (2026-10-30). Node 18.14+.
- It **bundles a native Claude Code binary** as an optional dependency (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`). SDK `0.3.N` tracks CLI `2.1.N`. `pathToClaudeCodeExecutable` can point it at `/Users/me/.local/bin/claude` instead.
- It is a typed wrapper that runs the CLI as a subprocess: same tools, hooks, sessions and settings.
- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` returns a `Query`, which is an `AsyncGenerator<SDKMessage>`. Its methods are `interrupt()`, `setPermissionMode()`, `setModel()`, `close()`, `mcpServerStatus()`, `accountInfo()`, `getContextUsage()`, `rewindFiles()`, `streamInput()` and more. Most control methods require streaming-input mode.
- Options mirror the CLI flags: `cwd`, `env` (default `process.env`), `model`, `fallbackModel`, `effort`, `thinking`, `permissionMode`, `permissionPrompts`, `allowedTools`, `disallowedTools`, `tools`, `canUseTool`, `hooks` (in-process callbacks), `mcpServers` (stdio, sse, http, or in-process `sdk` via `createSdkMcpServer()`/`tool()`), `agents`, `maxTurns`, `maxBudgetUsd`, `outputFormat: {type:"json_schema", schema}`, `includePartialMessages`, `resume`, `resumeSessionAt`, `continue`, `forkSession`, `sessionId`, `persistSession`, `settingSources` (**default: all CLI sources**; `[]` disables user, project and local), `settings`, `strictMcpConfig`, `systemPrompt`, `additionalDirectories`, `sandbox`, `abortController`, `stderr`, `spawnClaudeCodeProcess`.
- `canUseTool(toolName, input, {signal, suggestions, toolUseID, …})` resolves to `{behavior:"allow", updatedInput?, updatedPermissions?}` or `{behavior:"deny", message, interrupt?}`. It is called **only** when the flow would otherwise prompt. It may stay pending indefinitely. Return `updatedInput` with every allow.
- Message types are the same JSON as CLI stream-json: `SDKSystemMessage` (init), `SDKAssistantMessage`, `SDKUserMessage`, `SDKPartialAssistantMessage` (`stream_event`), `SDKResultMessage`, `SDKRateLimitEvent`, `SDKPermissionDeniedMessage`, `SDKAPIRetryMessage`, and others.

**Auth with a subscription.** The docs say, verbatim: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."* The quickstart only documents `ANTHROPIC_API_KEY`, Bedrock, Claude Platform on AWS, Vertex and Foundry.

Technically, the SDK runs the same binary with the same credential precedence, and the docs refer to claude.ai logins in SDK sessions. Examples: `forceLoginOrgUUID` applies to "Agent SDK logins"; plan usage reports need a claude.ai credential with `user:profile`. So a keychain login or `CLAUDE_CODE_OAUTH_TOKEN` would very likely work for **personal use on your own machine** [unverified; the SDK was not installed]. The documented, supported path for the SDK remains an API key, and the SDK is governed by the Commercial Terms [docs].

**Fit for the factory.** Spawning the CLI is the better fit here:

- It honours the no-API-key / no-Anthropic-SDK constraint.
- It is identical to how the other runners (Codex, Gemini, Cursor, Copilot) are driven.
- It gives the same JSON events.
- It keeps the binary version under the factory's control.

What you give up:

| SDK feature | CLI replacement |
|---|---|
| In-process `canUseTool` | `--permission-prompt-tool` (MCP) or PreToolUse hooks with `defer` (§3.3) |
| In-process hooks | Command or http hooks |
| `interrupt()` | SIGINT |
| `setPermissionMode()` mid-run | Restart with `--resume` and a different `--permission-mode` |
| Typed messages | Your own `zod` schemas for the event shapes in §2.2 |

---

## 8. Other relevant docs, briefly

**GitHub Actions.** `anthropics/claude-code-action@v1` [docs]:

- Inputs: `prompt`, `claude_args` (any CLI flags, e.g. `--max-turns 5 --model … --allowedTools …`), `anthropic_api_key` **or `claude_code_oauth_token`** (subscription token from `claude setup-token`), `github_token`, `settings`, `plugins`, `plugin_marketplaces`, `trigger_phrase`, `use_bedrock`/`use_vertex`/`use_foundry`.
- Interactive mode answers `@claude` mentions; automation mode runs whenever `prompt` is set.
- The docs recommend an API key rather than an OAuth token for secrets shared across an org, because the token is tied to the subscription of the person who created it.

**Claude Code in Slack.** Routes @Claude mentions in channels to **Claude Code cloud sessions** (claude.ai/code) on GitHub repos under the user's plan limits [docs]:

- This older version answers only Pro, Max and Ultra accounts.
- There is no local API or webhook exposure, so it can't drive this factory.
- For chat ingress, the factory needs its own Slack app that calls the local `AgentRunner`.

**Common workflows.** These confirm the patterns used above: `--worktree` for parallel sessions, `--continue`/`--resume`, `--permission-mode plan`, piping into `claude -p` [docs].

---

## 9. Alternative runners (for the adapter interface)

### OpenAI Codex CLI

Checked against **codex-cli 0.153.4** installed at `~/.local/bin/codex` [local]; npm latest is 0.166.0.

- **Invocation:** `codex exec [OPTIONS] [PROMPT]`. With no prompt or `-`, it reads stdin. Progress goes to stderr and the final message to stdout [local + docs].
- **`--json`:** stdout becomes JSONL. Event types are `thread.started` (with `thread_id`), `turn.started`, `item.started`/`item.completed`, `turn.completed` (with `usage`: input, cached input, output and reasoning tokens), `turn.failed` and `error`.
  - Item kinds: agent message, reasoning, command execution, file change, MCP tool call, web search, plan update [docs].
  - The type strings and the field names `cached_input_tokens`/`reasoning_output_tokens` are present in the binary [local]. The exact nesting of fields inside an item is [unverified].
- **Other output:** `--output-schema <file>` for a JSON-Schema final answer; `-o/--output-last-message <file>`.
- **Sandbox:** `-s/--sandbox read-only|workspace-write|danger-full-access`, default read-only. `--approve-for-me` routes approvals through automatic review in a workspace-write sandbox. `--dangerously-bypass-approvals-and-sandbox` skips both.
- **`--full-auto` no longer exists.** In 0.153.4 it gives `unexpected argument '--full-auto'`, and `-a/--ask-for-approval` isn't accepted by `exec` either [local]. The docs say: "`--full-auto` is no longer supported."
- **Other flags:**
  - `-C/--cd <dir>`, `--add-dir`, `--skip-git-repo-check` (exec requires a git repo).
  - `--ephemeral` (no session files), `-m/--model`, `-c key=value` (config overrides), `--ignore-user-config`.
  - `-p` means `--profile`, **not** prompt.
- **Resume:** `codex exec resume <SESSION_ID|thread name> [PROMPT]` or `--last`; `codex exec fork <id>` [local].
- **Auth:** reuses the saved login (ChatGPT plan or API key). The docs recommend `CODEX_API_KEY`, set only on the invocation.
- **Cost:** tokens only, no USD.

### Gemini CLI

Checked against **0.31.0** installed at `/opt/homebrew/bin/gemini` [local]; npm `@google/gemini-cli` latest is 0.66.0.

- **Invocation:** `gemini -p "<prompt>"`. stdin is appended. Headless mode also activates when there is no TTY.
- **Output:** `-o/--output-format text|json|stream-json`.
  - `json` gives one object `{response, stats, error?}`.
  - `stream-json` gives JSONL events `init` (session id, model), `message`, `tool_use`, `tool_result`, `error` and `result` (aggregated stats, per-model tokens) [docs].
- **Exit codes:** 0 OK, 1 error, 42 input error, 53 turn limit exceeded [docs].
- **Approvals:** `--approval-mode default|auto_edit|yolo|plan`, `-y/--yolo`, `--policy <files>`. `--allowed-tools` is deprecated in favour of the policy engine.
- **Sandbox and workspace:** `-s/--sandbox`, `--include-directories`, `-m/--model` [local].
- **Resume:** `-r/--resume latest|<index>` and `--list-sessions`. **Resume is by index, not by a stable id** [local]. The adapter has to map ids to indexes or always use `latest` in a dedicated cwd.
- **Auth:** headless uses cached "Sign in with Google" credentials if present; otherwise `GEMINI_API_KEY` or Vertex (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` + ADC or service account) [docs].
- **Caveat:** geminicli.com says Gemini CLI was replaced by **Antigravity CLI** on 2026-06-18 for unpaid and Google One users [docs].

### Cursor CLI

Not installed [local]. The binary is `agent` (older name `cursor-agent`) [docs].

- **Invocation:** `agent -p "<prompt>"`, optionally with `--output-format text|json|stream-json` and `--stream-partial-output`.
- **Writes:** without `-f/--force` (alias `--yolo`), it only *proposes* changes.
- **Other flags:**
  - `--model`, `--mode plan|ask`, `--resume [chatId]`, `--continue`, `create-chat` (returns a chat id), `ls`.
  - `--workspace <path>`, `--sandbox enabled|disabled`, `--approve-mcps`, `--trust` (headless only).
  - `-w/--worktree [name]` (under `~/.cursor/worktrees/<repo>/<name>`).
- **Auth:** `--api-key` or `CURSOR_API_KEY`.
- **stream-json events:** `system` (`subtype:"init"`, `model`), `assistant` (`message.content[0].text`, `model_call_id`), `tool_call` (`subtype:"started"|"completed"`, e.g. `writeToolCall`/`readToolCall` with `args.path` and `result.success`), and `result` (`duration_ms`) [docs]. The full schema is [unverified].

### GitHub Copilot CLI

Not installed [local]; npm `@github/copilot` latest is 1.0.105. The binary is `copilot` [docs].

- **Invocation:** `copilot -p "<prompt>"` runs once and exits.
- **Permissions:** `--allow-tool='shell'`, `--deny-tool=…`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`, `--allow-url`/`--deny-url`, `--allow-all`/`--yolo` (all three allow-alls). `--assisted-approval` is non-interactive only: a safety review approves eligible requests and denies the rest. Without permission flags, approvals are denied.
- **Output:** `--output-format text|json`. `json` emits JSONL, but the event schema for `-p` runs is **not documented** [docs; community reports agree]. `-s/--silent` prints the response only. `--share[=path]` exports a markdown transcript.
- **Other flags:** `--model`, `--no-ask-user`, `--agent <name>`, `--add-dir`, `--resume`, `--continue`, `--session-id` (mentioned).
- **Auth:** `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`.
- **Usage:** reported via `/usage` (GitHub AI Credits). No headless usage field is documented.

### Implications for the adapter

| Concern | Claude Code | Codex | Gemini | Cursor | Copilot |
|---|---|---|---|---|---|
| Headless flag | `-p` | `exec` | `-p` | `-p` | `-p` |
| Event stream | stream-json (rich) | `--json` JSONL | stream-json | stream-json | json (JSONL, undocumented) |
| Session handle | UUID, pre-assignable | `thread_id` | index / `latest` | chat id (`create-chat`) | session id |
| Structured output | `--json-schema` | `--output-schema` | no | no | no |
| Turn or budget cap | `--max-turns`, `--max-budget-usd` | no | turn limit (exit 53) | no | no |
| Permission model | modes + rules + hooks | sandbox levels | approval modes + policy | force / sandbox | allow/deny tool lists |
| Cost data | tokens + USD estimate + rate-limit windows | tokens | tokens (stats) | duration only | none |

---

## 10. Proposed `AgentRunner` interface and Claude Code implementation sketch

### 10.1 Interface (`src/runners/types.ts`)

```ts
export type RunnerId = "claude-code" | "codex" | "gemini" | "cursor" | "copilot";

export interface RunnerCapabilities {
  eventStream: "rich" | "basic" | "final-only";
  partialText: boolean;
  resume: "by-id" | "by-index" | "latest" | "none";
  presetSessionId: boolean;            // claude: --session-id
  fork: boolean;
  structuredOutput: boolean;           // claude --json-schema, codex --output-schema
  maxTurns: boolean;
  budgetCapUsd: boolean;
  cost: "usd-estimate+tokens" | "tokens" | "none";
  rateLimitTelemetry: boolean;         // claude rate_limit_event
  permissionControls: ReadonlyArray<"modes" | "allow-rules" | "deny-rules" | "hooks" | "sandbox" | "prompt-tool">;
  gracefulInterrupt: boolean;          // SIGINT ends turn cleanly
  deferApprovals: boolean;             // claude PreToolUse "defer"
  builtinWorktree: boolean;
}

/** Runner-neutral autonomy levels; each adapter maps them to its own flags. */
export type Autonomy = "read-only" | "edit" | "edit+allowlisted-shell" | "classifier-auto" | "bypass-in-sandbox";

export interface RunRequest {
  runId: string;                       // factory id (also used for log correlation)
  cwd: string;                         // the task's git worktree
  prompt: string;                      // sent on stdin
  sessionId?: string;                  // pre-assigned (if presetSessionId)
  resume?: { sessionId: string; fork?: boolean };
  model?: string;
  fallbackModels?: string[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  appendSystemPrompt?: string;
  autonomy: Autonomy;
  allow?: string[];                    // runner-specific rule strings
  deny?: string[];
  limits?: { maxTurns?: number; maxBudgetUsd?: number; wallClockMs?: number };
  outputSchema?: Record<string, unknown>;
  extraDirs?: string[];
  mcpConfigPath?: string;
  settingsPath?: string;               // factory-owned runner config file
  env?: Record<string, string>;        // extra, allowlisted env for the task
}

export type AgentEvent =
  | { type: "started"; sessionId: string; model?: string; authOk: boolean; raw: unknown }
  | { type: "text_delta"; text: string }
  | { type: "assistant_text"; text: string; parentToolUseId: string | null }
  | { type: "tool_call"; id: string; name: string; input: unknown; parentToolUseId: string | null }
  | { type: "tool_result"; id: string; isError: boolean; preview: string }
  | { type: "permission_denied"; tool: string; message: string }
  | { type: "rate_limit"; status: string; resetsAt?: number; windows: Record<string, { utilization: number; resetsAt: number; status: string }> }
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; error: string; httpStatus: number | null }
  | { type: "stderr"; line: string }
  | { type: "unknown"; raw: unknown };

export interface UsageReport {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  costUsd?: number;                                   // runner-reported
  costBasis: "billed" | "list-estimate" | "unknown";  // claude subscription ⇒ "list-estimate"
  cumulativeForSession: boolean;                      // claude resumed runs report whole-session totals
  perModel?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd?: number }>;
}

export interface RunResult {
  status: "success" | "max_turns" | "budget_exceeded" | "usage_limited" | "deferred" | "error" | "cancelled";
  sessionId?: string;
  text?: string;
  structured?: unknown;
  deferredTool?: { id: string; name: string; input: unknown };
  numTurns?: number;
  durationMs: number;
  usage: UsageReport;
  permissionDenials: Array<{ tool: string; input: unknown }>;
  errors: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  raw?: unknown;                       // the runner's final record, for debugging
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly done: Promise<RunResult>;
  /** graceful: end the current turn (SIGINT) then escalate; hard: SIGTERM→SIGKILL. */
  cancel(mode?: "graceful" | "hard"): Promise<void>;
}

export interface RunnerProbe { version: string; authenticated: boolean; authMethod?: string; plan?: string; warnings: string[] }

export interface AgentRunner {
  readonly id: RunnerId;
  readonly capabilities: RunnerCapabilities;
  probe(): Promise<RunnerProbe>;       // must not spend model quota
  start(req: RunRequest): AgentRun;    // req.resume ⇒ follow-up on an existing session
}
```

### 10.2 Claude Code implementation (`src/runners/claude-code.ts`, sketch)

```ts
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { AgentEvent, AgentRun, AgentRunner, RunRequest, RunResult, RunnerCapabilities, RunnerProbe } from "./types.js";

const BIN = "/Users/me/.local/bin/claude";
const execFileP = promisify(execFile);

/** Allowlist env: never inherit ANTHROPIC_*, CLAUDE_*, CLAUDECODE, cloud-provider switches. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env,
    TERM: "dumb", NO_COLOR: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // CLAUDE_CONFIG_DIR: `${process.env.HOME}/.software-factory/claude`,  // isolated profile; log in once with the same var
    ...extra,
  };
}

function permissionArgs(req: RunRequest): string[] {
  const a: string[] = ["--permission-prompts", "none"];
  switch (req.autonomy) {
    case "read-only":              a.push("--permission-mode", "dontAsk", "--disallowedTools=Edit,Write,NotebookEdit"); break;
    case "edit":                   a.push("--permission-mode", "acceptEdits"); break;
    case "edit+allowlisted-shell": a.push("--permission-mode", "dontAsk"); break; // allow rules come from --settings / req.allow
    case "classifier-auto":        a.push("--permission-mode", "auto"); break;
    case "bypass-in-sandbox":      a.push("--dangerously-skip-permissions"); break; // only inside a VM/container
  }
  if (req.allow?.length) a.push(`--allowedTools=${req.allow.join(",")}`);      // '=' form: variadic options can't swallow anything
  if (req.deny?.length)  a.push(`--disallowedTools=${req.deny.join(",")}`);
  return a;
}

function buildArgs(req: RunRequest): string[] {
  const a = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (req.resume) { a.push("--resume", req.resume.sessionId); if (req.resume.fork) a.push("--fork-session"); }
  else if (req.sessionId) a.push("--session-id", req.sessionId);
  if (req.model) a.push("--model", req.model);
  if (req.fallbackModels?.length) a.push("--fallback-model", req.fallbackModels.join(","));
  if (req.effort) a.push("--effort", req.effort);
  if (req.limits?.maxTurns) a.push("--max-turns", String(req.limits.maxTurns));          // hidden flag, works in 2.1.314
  if (req.limits?.maxBudgetUsd) a.push("--max-budget-usd", req.limits.maxBudgetUsd.toFixed(2));
  if (req.appendSystemPrompt) a.push("--append-system-prompt", req.appendSystemPrompt);  // ignored on resume (snapshot)
  if (req.outputSchema) a.push("--json-schema", JSON.stringify(req.outputSchema));
  if (req.settingsPath) a.push("--settings", req.settingsPath);
  a.push("--strict-mcp-config");
  if (req.mcpConfigPath) a.push(`--mcp-config=${req.mcpConfigPath}`);
  for (const d of req.extraDirs ?? []) a.push(`--add-dir=${d}`);
  a.push(...permissionArgs(req));
  return a;                                   // prompt goes on stdin; no positional args at all
}

/** Minimal push/pull async queue. */
class Queue<T> implements AsyncIterable<T> {
  private items: T[] = []; private waiters: ((r: IteratorResult<T>) => void)[] = []; private closed = false;
  push(v: T) { const w = this.waiters.shift(); w ? w({ value: v, done: false }) : this.items.push(v); }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.items.length ? Promise.resolve({ value: this.items.shift()!, done: false })
      : this.closed ? Promise.resolve({ value: undefined as never, done: true })
      : new Promise(r => this.waiters.push(r)) };
  }
}

function mapResult(ev: any, exitCode: number | null, signal: NodeJS.Signals | null, cancelled: boolean): RunResult {
  const mu = ev?.modelUsage ?? {};
  const sum = (k: string) => Object.values<any>(mu).reduce((n, m) => n + (m?.[k] ?? 0), 0);
  const bases = new Set(Object.values<any>(mu).map(m => m?.costBasis));
  const limited = ev?.api_error_status === 429 || /hit your (session|weekly|\w+) limit/i.test(String(ev?.result ?? ""));
  const status: RunResult["status"] =
    cancelled ? "cancelled"
    : !ev ? "error"
    : ev.stop_reason === "tool_deferred" || ev.deferred_tool_use ? "deferred"
    : ev.subtype === "error_max_turns" ? "max_turns"
    : ev.subtype === "error_max_budget_usd" ? "budget_exceeded"
    : limited ? "usage_limited"
    : ev.subtype === "success" && !ev.is_error ? "success" : "error";
  return {
    status, sessionId: ev?.session_id, text: ev?.result, structured: ev?.structured_output,
    deferredTool: ev?.deferred_tool_use, numTurns: ev?.num_turns, durationMs: ev?.duration_ms ?? 0,
    usage: {
      inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadInputTokens"), cacheWriteTokens: sum("cacheCreationInputTokens"),
      costUsd: ev?.total_cost_usd, costBasis: bases.has("list") ? "list-estimate" : "unknown",
      cumulativeForSession: true,
      perModel: Object.fromEntries(Object.entries<any>(mu).map(([k, m]) => [k, {
        input: m.inputTokens, output: m.outputTokens, cacheRead: m.cacheReadInputTokens,
        cacheWrite: m.cacheCreationInputTokens, costUsd: m.costUSD }])),
    },
    permissionDenials: (ev?.permission_denials ?? []).map((d: any) => ({ tool: d.tool_name, input: d.tool_input })),
    errors: ev?.errors ?? [], exitCode, signal, raw: ev,
  };
}

export class ClaudeCodeRunner implements AgentRunner {
  readonly id = "claude-code" as const;
  readonly capabilities: RunnerCapabilities = {
    eventStream: "rich", partialText: true, resume: "by-id", presetSessionId: true, fork: true,
    structuredOutput: true, maxTurns: true, budgetCapUsd: true, cost: "usd-estimate+tokens",
    rateLimitTelemetry: true, permissionControls: ["modes", "allow-rules", "deny-rules", "hooks", "prompt-tool"],
    gracefulInterrupt: true, deferApprovals: true, builtinWorktree: true,
  };

  async probe(): Promise<RunnerProbe> {             // no model call, no quota
    const env = childEnv();
    const { stdout: v } = await execFileP(BIN, ["--version"], { env });
    const { stdout: s } = await execFileP(BIN, ["auth", "status", "--json"], { env });
    const st = JSON.parse(s);
    const warnings = st.authMethod !== "claude.ai" ? [`unexpected authMethod ${st.authMethod}`] : [];
    return { version: v.trim(), authenticated: !!st.loggedIn, authMethod: st.authMethod, plan: st.subscriptionType, warnings };
  }

  start(req: RunRequest): AgentRun {
    const events = new Queue<AgentEvent>();
    const child = spawn(BIN, buildArgs(req), { cwd: req.cwd, env: childEnv(req.env), stdio: ["pipe", "pipe", "pipe"] });
    let final: any; let cancelled = false; let wallTimer: NodeJS.Timeout | undefined;

    child.stdin.end(req.prompt);

    createInterface({ input: child.stderr, crlfDelay: Infinity })
      .on("line", line => events.push({ type: "stderr", line }));   // e.g. "this workspace has not been trusted"

    const pump = (async () => {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        let ev: any; try { ev = JSON.parse(line); } catch { events.push({ type: "stderr", line }); continue; }
        if (ev.type === "system" && ev.subtype === "init") {
          const authOk = ev.apiKeySource === "none";            // subscription OAuth; anything else ⇒ API key leaked in
          events.push({ type: "started", sessionId: ev.session_id, model: ev.model, authOk, raw: ev });
          if (!authOk) void this.kill(child, "hard");
        } else if (ev.type === "system" && ev.subtype === "api_retry") {
          events.push({ type: "retry", attempt: ev.attempt, maxRetries: ev.max_retries, delayMs: ev.retry_delay_ms, error: ev.error, httpStatus: ev.error_status });
        } else if (ev.type === "system" && ev.subtype === "permission_denied") {
          events.push({ type: "permission_denied", tool: ev.tool_name, message: ev.message });
        } else if (ev.type === "stream_event") {
          const e = ev.event;
          if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") events.push({ type: "text_delta", text: e.delta.text });
        } else if (ev.type === "assistant") {
          for (const b of ev.message?.content ?? []) {
            if (b.type === "text") events.push({ type: "assistant_text", text: b.text, parentToolUseId: ev.parent_tool_use_id });
            else if (b.type === "tool_use") events.push({ type: "tool_call", id: b.id, name: b.name, input: b.input, parentToolUseId: ev.parent_tool_use_id });
          }
        } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content) if (b.type === "tool_result") {
            const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
            events.push({ type: "tool_result", id: b.tool_use_id, isError: !!b.is_error, preview: text.slice(0, 2000) });
          }
        } else if (ev.type === "rate_limit_event") {
          const i = ev.rate_limit_info ?? {};
          events.push({ type: "rate_limit", status: i.status, resetsAt: i.resetsAt, windows: i.unifiedWindows ?? {} });
        } else if (ev.type === "result") {
          final = ev;                                            // last result wins (background work can add turns)
        } else {
          events.push({ type: "unknown", raw: ev });
        }
      }
    })();

    const done = new Promise<RunResult>(resolve => {
      child.on("close", async (code, signal) => {
        clearTimeout(wallTimer);
        await pump.catch(() => {});
        events.close();
        resolve(mapResult(final, code, signal, cancelled));
      });
    });

    if (req.limits?.wallClockMs) wallTimer = setTimeout(() => void run.cancel("graceful"), req.limits.wallClockMs);

    const run: AgentRun = {
      runId: req.runId, events, done,
      cancel: async (mode = "graceful") => { cancelled = true; await this.kill(child, mode); },
    };
    return run;
  }

  /** SIGINT ends the turn cleanly; SIGTERM exits 143 (kills Bash process trees, runs SessionEnd); SIGKILL last. */
  private async kill(child: ReturnType<typeof spawn>, mode: "graceful" | "hard") {
    const wait = (ms: number) => new Promise<boolean>(r => {
      const t = setTimeout(() => r(false), ms); child.once("close", () => { clearTimeout(t); r(true); });
    });
    if (child.exitCode !== null) return;
    if (mode === "graceful") { child.kill("SIGINT"); if (await wait(15_000)) return; }
    child.kill("SIGTERM"); if (await wait(10_000)) return;
    child.kill("SIGKILL");
  }
}
```

### 10.3 Using it for a task and a review round

```ts
const runner = new ClaudeCodeRunner();
const sessionId = crypto.randomUUID();
const base = {
  cwd: "/work/app/task-123", autonomy: "edit+allowlisted-shell" as const,
  settingsPath: "/Users/me/.software-factory/claude-settings.json",
  limits: { maxTurns: 80, maxBudgetUsd: 25, wallClockMs: 45 * 60_000 },
};

const run1 = runner.start({ ...base, runId: "task-123#1", sessionId, prompt: taskSpec,
  appendSystemPrompt: "You are running unattended inside a software factory. Never push." });
for await (const ev of run1.events) ui.publish(ev);          // live progress (text_delta, tool_call, rate_limit…)
const r1 = await run1.done;                                   // r1.usage.costUsd is the session total so far

// Reviewer feedback → same session, same worktree
const run2 = runner.start({ ...base, runId: "task-123#2", resume: { sessionId },
  prompt: `Code review feedback:\n${review}\nAddress every point, rerun tests, summarise.` });
const r2 = await run2.done;
const deltaUsd = (r2.usage.costUsd ?? 0) - (r1.usage.costUsd ?? 0);   // resumed totals are cumulative
```

### 10.4 Mapping notes for other adapters

- **Codex.**
  - Command: `codex exec --json -C <cwd> -s workspace-write [-m model] [--output-schema f] -` with the prompt on stdin. For follow-ups: `codex exec resume <thread_id> -`.
  - `thread.started.thread_id` gives `sessionId`. Map `item.*` to `tool_call`/`tool_result`/`assistant_text`, and `turn.completed.usage` to `UsageReport` (`costBasis: "unknown"`, no USD).
  - Autonomy mapping: `read-only` → `-s read-only`; `edit` and `edit+allowlisted-shell` → `-s workspace-write`; `classifier-auto` → `--approve-for-me`; `bypass-in-sandbox` → `--dangerously-bypass-approvals-and-sandbox`. There are no allow or deny rule strings, so set `capabilities.permissionControls = ["sandbox"]`.
- **Gemini.**
  - Command: `gemini -p <prompt> -o stream-json --approval-mode auto_edit|yolo|plan [-m]`.
  - Resume is by `-r latest` per dedicated cwd (`resume: "latest"`).
  - The final `result` event carries stats; exit 53 maps to `max_turns`.
- **Cursor.** `agent -p --output-format stream-json --stream-partial-output --workspace <cwd> --trust [--force] [--resume <chatId>]`. `create-chat` provides a pre-assigned id.
- **Copilot.**
  - Command: `copilot -p <prompt> --output-format json --no-ask-user --allow-tool=… | --assisted-approval [--model]`.
  - Treat the event stream as `basic`, because the schema is undocumented, and always keep a `raw` fallback.

---

## 11. Unverified or open items

1. Exact stdin JSON contract for `--input-format stream-json` in the CLI (assumed to be the SDK's `SDKUserMessage` shape), and the control-request (interrupt) messages over stdin.
2. `--permission-prompt-tool` input schema (assumed `{tool_name, input, tool_use_id}`) and its timeout behaviour.
3. Whether `--output-format json --verbose` in 2.1.314 prints an array of all messages, as older versions did. Avoid combining them; use stream-json.
4. Whether `--setting-sources project,local` also suppresses user-level CLAUDE.md, skills, agents and plugins.
5. That allow rules passed via `--settings` and `--allowedTools` are not trust-gated in `-p`. This is inferred from the docs' trust table listing only repository content.
6. Whether `rate_limit_event` is emitted when authenticating with a `setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`).
7. The exact `result` text and `api_error_status` when a subscription limit is reached mid-run in `-p`.
8. Safety of many concurrent `claude -p` processes writing `~/.claude.json` and `~/.claude/projects`.
9. The Agent SDK running on the keychain subscription login. It is technically expected to work but is not the documented path, and it was not installed or tested.
10. Fields of `http` hooks (url, headers, timeout semantics). The hook type is documented; its schema was not read.
11. Codex `item.*` field nesting, Cursor's full stream-json schema, and Copilot's `-p` JSONL schema.
12. Undocumented result fields observed locally (`model_usage_since_last_result`, `subagent_stats`, `safety_stops`). Don't depend on them.

## 12. Sources

- Local: `claude --help`, `claude -p --help`, `claude auth|mcp|agents --help`, flag probes with empty stdin, strings in `~/.local/share/claude/versions/2.1.314`, one smoke test (`/tmp/cc-smoke/out.jsonl`), `codex exec --help`, `codex exec resume --help`, `gemini --help`, `npm view` for package versions.
- Claude Code docs (fetched 2026-10-30): [headless](https://code.claude.com/docs/en/headless), [cli-reference](https://code.claude.com/docs/en/cli-reference), [agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview), [agent-sdk/quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart), [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript), [agent-sdk/user-input](https://code.claude.com/docs/en/agent-sdk/user-input), [agent-sdk/streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [agent-sdk/cost-tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking), [hooks](https://code.claude.com/docs/en/hooks), [settings](https://code.claude.com/docs/en/settings), [permissions](https://code.claude.com/docs/en/permissions), [permission-modes](https://code.claude.com/docs/en/permission-modes), [sub-agents](https://code.claude.com/docs/en/sub-agents), [skills](https://code.claude.com/docs/en/skills), [memory](https://code.claude.com/docs/en/memory), [mcp](https://code.claude.com/docs/en/mcp), [worktrees](https://code.claude.com/docs/en/worktrees), [env-vars](https://code.claude.com/docs/en/env-vars), [authentication](https://code.claude.com/docs/en/authentication), [costs](https://code.claude.com/docs/en/costs), [errors](https://code.claude.com/docs/en/errors), [github-actions](https://code.claude.com/docs/en/github-actions), [common-workflows](https://code.claude.com/docs/en/common-workflows), [slack](https://code.claude.com/docs/en/slack).
- Plans: [Use Claude Code with your Pro, Max, or Ultra plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan), [What is the Max plan?](https://support.claude.com/en/articles/11049741-what-is-the-max-plan).
- Other runners: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Gemini CLI headless](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md), [Gemini CLI auth](https://geminicli.com/docs/get-started/authentication/), [Cursor CLI headless](https://cursor.com/docs/cli/headless), [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters), [Copilot CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference), [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/cli-command-reference); community notes on `--permission-prompt-tool`: [anthropics/claude-code#1175](https://github.com/anthropics/claude-code/issues/1175).
