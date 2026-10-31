# Architecture

One Node process: the HTTP API and the built web app, the pipeline that moves work items, the
pollers and sockets that bring work in, and the watchers that read pull requests back. State is
Postgres; live updates fan out in-process over server-sent events. Agents are child processes in
git worktrees.

```
                 browsers ── SSE ──┐
  Slack socket ─┐                  │
  Jira / GitHub / Linear pollers ──┤       ┌───────────────┐       ┌──────────────┐
  schedule / watch / webhook ──────┼──────▶│   pipeline    │──────▶│  runners     │── claude -p / codex exec / gemini
  Telegram (notifier hook) ────────┤       │  tick + gates │       │  (adapters)  │   in data/work/<slug>/<item>
  form / API / CLI ────────────────┘       └──────┬────────┘       └──────────────┘
                                                  │ events, runs, approvals, feedback, posts, notes
                                                  ▼
                                               Postgres (factory)
```

## Work items and their state

`work_items.status` is the one word that says where a request is:

| status | meaning | who moves it |
|---|---|---|
| `inbox` | arrived, has a project (or waits for one) | tick → plan |
| `planning` | plan run active | run result |
| `needs_info` | planner asked questions | an answer (comment) → inbox |
| `awaiting_approval` | `gate` = plan / merge / deploy | a decision |
| `queued` | plan accepted, waiting for a build slot | tick → build |
| `building` / `verifying` / `reviewing` / `fixing` | the build loop | run results, verify results |
| `review` | PR open or local diff ready | reviewer verdict, PR watcher |
| `merging` / `deploying` | the factory's own commands | results |
| `done` / `failed` / `cancelled` | closed | — |
| `blocked` | needs a person; error on the row; retryable | retry / cancel |

Every transition is an `events` row of type `status` with the actor. `runs` are one agent
invocation each (plan, build, fix, review, learn) with the prompt, the result, the session id,
cost and usage. `approvals` are the gates (pending → approved/rejected/expired). `feedback` is
what people said (comment, answer, changes_requested, approved), deduplicated by external id so a
Slack reply or a GitHub comment is used once. `posts` is what the factory told the outside world.
`notes` is the book.

## The tick

Every three seconds `pipeline.tick()`:

1. stops if the factory is paused, or if the runner's five-hour plan window is past the threshold
   (`usage` from the CLI's `rate_limit_event`);
2. drains follow-ups (fix rounds, re-plans) first — they are closest to done;
3. starts plans for `inbox` items and builds for `queued` items, respecting
   `MAX_CONCURRENT_RUNS`, the project's `concurrency`, and its `maxInReview` (no new builds while
   reviewers are behind).

Everything else is event-driven: a run finishing calls the next stage directly; a decision
(`decide`) or a review verdict (`reviewDecision`) or a comment (`onComment`) comes from a route,
a source adapter, the PR watcher or the Telegram hook and moves the item.

## Runs

`startRun` creates the row, reserves the item's slot (one active run per item), streams the
runner's events into `events` (text, tool, tool_result, log, denied, usage), then records cost,
turns, usage, the session id and the structured answer. A `Cancelled` sentinel unwinds the stage
when a person cancels. Prompts are built in `prompts.ts` and kept on the run row verbatim.

### Moving an item safely

`setStatus` refuses to move an item that is done, cancelled or failed unless the caller says
`force` (retry does); a stage that tries anyway gets `ItemClosed` and unwinds. `claim(id, from[],
to)` is a conditional update: `merge()` and `deploy()` claim the item before acting, so two
approvals arriving together (a Slack button and the pull request) act once. Every stage reserves
the item's slot (one AbortController) and checks `stillWanted()` between steps, so a cancel
during a push, a verify or a deploy is honoured. `fail()` records `failed_stage` (plan, build,
merge, deploy); `retry()` resumes there — a failed deploy is retried as a deploy, not a rebuild.

### When the base moves

A merge that conflicts (the default branch moved while the job waited in review) is not the end:
`reconcile()` merges the base into the job's branch in its worktree; a clean merge goes straight
to verify and merge; conflicts are handed to the agent as a fix round with the conflicted files
named and the merge left in progress, then verified and landed. Each round counts toward
`maxFixRounds`.

## Git

`git.ts`: everything that touches a shared repository runs under `withRepoLock(dir)` (git takes
locks on the index, refs and config; two jobs creating worktrees at once would trip over each
other). `ensureRepo` (clone or fetch), `createWorktree` (`factory/<id>-<slug>` from
`origin/<default>` or the local default branch; reuses the branch on retry so commits survive),
`settle` (commit what the agent left), `diff`, `push --force-with-lease`, `openPr` / `mergePr`
through `gh`, `mergeLocal` (`--no-ff` into a clean local checkout on its default branch, refuses
otherwise), `removeWorktree`. Worktrees of finished jobs are removed after `keepWorktreeDays`.

## Runners

`AgentRunner` (`runners/index.ts`): `check()`, `run(spec, onEvent, signal)`. `RunSpec` carries
cwd, prompt, an appended system prompt, model/effort, limits, the tool policy
(`none | readonly | edit | full` + allow/deny), an optional JSON schema for a structured answer,
and a session to resume. `RunEvent`s are init / text / tool_use / tool_result / log / usage /
denied; `RunResult` has ok, result, structured, cost, turns, usage, sessionId, error.

The Claude adapter maps the policy onto `--permission-mode` + `--allowedTools` / `--disallowedTools`
with `--permission-prompts none` (nothing ever prompts; denials are reported), loads only the
repository's own settings (`--setting-sources project`), ignores this Mac's MCP servers
(`--strict-mcp-config`), pins or resumes a session id, and parses stream-json line by line.

## Sources

`SourceAdapter` (`sources/index.ts`): `fields` (rendered by the UI), `poll(ctx)` on an interval or
cron, or `start(ctx)` for a long-lived connection, `post(ctx, item, msg)` to carry status back,
`test`, `webhook`. The context dedupes items by external id, routes comments and verdicts into the
pipeline, and keeps a cursor per source. Secrets are sealed with AES-GCM under `FACTORY_SECRET`.

## Status back

`conversations.postStatus(item, msg)` posts to the origin's poster (Slack thread, Jira comment,
GitHub comment, Linear comment) and, for anything marked important (questions, approvals, ready
for review, done, blocked), to Telegram through the notifier with buttons whose data the hook
understands (`approve:<id>`, `reject:<id>`, `review-approve:<item>`).

## Processes

`exec.run` spawns every child detached, as its own process group: a timeout or a cancel kills
the group (a test runner's lingering grandchild cannot hold the pipes open forever), and the
result resolves shortly after `exit` even if a pipe is still held. Project commands (`shell`)
run with the agent's credential-free environment, because they run what the agent wrote; the
factory's own git runs with `core.hooksPath=/dev/null` so repository hooks never run under the
factory's credentials. On shutdown every tracked child is killed.

## Security model

- Sessions: random token, sha256 stored, 90 days, revocable; API tokens `ft_…` for scripts.
- Roles: pending (nothing), viewer (GET), member (work), admin (people, settings, deletions).
- CSRF: non-GET requests must be same-origin (Origin / Sec-Fetch-Site) unless they carry an API token.
- Strict CSP; no inline scripts; the proxy's `X-Forwarded-Proto` marks requests from outside, and
  dev login and the notifier hook refuse them.
- Agents: worktree-only, allow-listed environment with no git credentials (`GIT_CONFIG_GLOBAL=/dev/null`,
  an empty `GH_CONFIG_DIR`, no SSH agent, ssh told to use no identity and no config, no npm user
  config, `git config` writes denied, repository hooks and fsmonitor off through
  `GIT_CONFIG_PARAMETERS`), deny-listed commands, a
  per-run budget and a per-job cap (twice the run budget), wall clock, loop guard, concurrency,
  review WIP, daily budget, kill switch.
- Roles: projects and sources are created and changed by admins; members may change a project's
  words and model only; a request is frozen once its plan is accepted. Chat and ticket sources can
  name who may decide; GitHub pull-request feedback counts only from owners, members and collaborators.
