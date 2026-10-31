# Software Factory

Work comes in from wherever people already are — a form, Slack, Jira, GitHub issues, Linear, a
schedule, a watch on a running service, a webhook, Telegram — and comes out the other end as a
shipped change: planned, built in its own branch, verified, reviewed, merged and deployed, with
people deciding at the gates they choose to keep. Everyone sees where every request is, live.
What a job teaches is written down for the next one.

```
            ┌─ Slack (socket mode) ─┐
            ├─ Jira (polling) ──────┤      plan ──▶ gate ──▶ build ──▶ verify ──▶ review ──▶ gate ──▶ merge ──▶ gate ──▶ deploy ──▶ done
 requests ──┼─ GitHub issues ───────┼──▶   │        plan     agent in   tests &    AI 2nd     merge    PR or     deploy   command,    note for
            ├─ Linear ──────────────┤      │      approval   a worktree build cmd  opinion,  approval  local     approval health     the book
            ├─ schedule / watch ────┤      │                            fix ⟲      PR/diff             merge              check
            ├─ webhook / API / CLI ─┤      └── status posted back to the thread / ticket / issue / Telegram, and the live board
            └─ the form ────────────┘
```

The agents that do the work sit behind an adapter. Today that is the **claude CLI** (`claude -p`)
on this Mac's subscription login; the Codex and Gemini CLIs are wired in as well, and any other
harness is one file. Sign-in is Google, like the other products on this machine.

## Run it

```sh
cp .env.example .env     # DATABASE_URL from ~/Self/dashboard/platform/db.sh url factory; FACTORY_SECRET; Google client; ADMIN_EMAILS
make db                  # the shared platform Postgres and the "factory" database
npm install
make deploy              # typecheck, build the UI, (re)start on http://127.0.0.1:8282
make launchd-install     # keep it running across logins (com.factory.web); rack shows it as software-factory/web
```

Node 22.18 or newer (25 on this Mac). The agent is the `claude` CLI: install it and log in once
(`claude`, then `/login`) as the user the factory runs as; Settings › Runners shows the version
it found. Changes to `.env` need `make deploy`. To try the whole loop without spending a token:
`DEMO_RUNNER=fake node demo/seed.ts` (with `DEV_LOGIN=1` in `.env`, or `FACTORY_TOKEN` set)
registers a tiny demo repository and files a first request; without `DEMO_RUNNER` it uses the
real agent.

`make dev` runs the API with reload on :8282 and Vite on :5282. `make check` typechecks and runs
the tests (end-to-end against `factory_test` with a fake runner; no model is called).

**First sign-in.** With `GOOGLE_CLIENT_ID`/`_SECRET` set and `<origin>/api/auth/google/callback`
registered on that OAuth client (`http://127.0.0.1:8282/api/auth/google/callback` for local use),
"Continue with Google" works. The addresses in `ADMIN_EMAILS` are admins; `ALLOWED_EMAILS` and
`ALLOWED_DOMAINS` are members; anyone else who signs in lands as *pending* and an admin lets them
in from **People**. With no admins named, the first account to sign in becomes the admin.
`DEV_LOGIN=1` adds a local email sign-in for development; it is refused through the proxy.

## A request's life

1. **Arrives** as a work item: title, request, project, priority, where it came from (its *origin*,
   which is where status goes back to). Items without a project wait in the inbox for someone to
   pick one.
2. **Plan.** An agent reads the request and the repository (read-only) and answers with a plan:
   summary, kind, size, risk, steps, files, how it will be verified, what "done" means — or the
   questions it cannot proceed without, in which case the item waits for an answer in the thread,
   the ticket, or the item page.
3. **Gate: plan.** Per project: `manual` (someone approves, from the board, Slack, Jira, GitHub,
   Telegram or the CLI), `auto`, or `auto_low_risk` (only high-risk plans wait).
4. **Build.** The agent works in a fresh **git worktree** on `factory/<id>-<title>`, with the
   project's toolchain allowed and pushing, credentials and the machine denied (the toolchain can
   still reach the network: `npm`, `node` and `python` do). It commits as it goes; whatever it
   leaves uncommitted is committed for it. It cannot ask questions: it decides, does, and reports.
5. **Verify.** The factory itself runs the project's `build_command` and `test_command`. A failure
   goes back to the same agent session as a fix round (resumed, so it remembers), up to
   `maxFixRounds`; then the item is **blocked** for a person.
6. **Review.** Optionally a second agent (a cheaper model) reads the diff against the plan and
   either approves or asks for changes (a fix round). Then: with delivery `pr`, the branch is
   pushed and a pull request opened through `gh`; reviews, comments, inline comments and failing
   checks on it flow back as feedback and fix rounds, an approval moves it on. With delivery
   `local` (a repository that lives on this Mac), the diff is reviewed in the factory and merged
   into the local checkout.
7. **Gate: merge**, then **merge** (squash through `gh pr merge`, or a local `--no-ff` merge). If the
   default branch moved while the job waited and the merge conflicts, the factory merges the base
   into the job's branch; conflicts go back to the agent as a fix round, verification runs again,
   and the change lands — up to `maxFixRounds` times before a person is asked.
8. **Gate: deploy**, then **deploy**: the project's `deploy_command` (`make deploy` for the apps on
   this Mac), followed by `health_url` until it answers 200, then watched for `observeMinutes`
   (a deploy that falls over a minute later is blocked, not done).
9. **Done.** A cheap model writes a note for **the book** — what was non-obvious, what to do
   differently — which goes into every later prompt for that project. The origin is told.

Every step is an event on the item: status changes, each line the agent said, each tool it ran
and what came back, test output, pushes, posts, approvals, feedback. The item page streams them
live; the board shows every item in its column; **Metrics** shows throughput, lead time, first-pass
rate, cost per shipped change, where time is spent, and what is waiting on a person. Once a day
(Settings › Daily digest) the factory posts a summary to Telegram and to Slack status channels:
the last 24 hours' arrivals, shipped and failed counts and cost, what shipped, and what waits on
a person and for what. A new account waiting to be let in is reported to Telegram once.

![The board: every request in its column, and what needs a person on top](docs/img/board.png)

![A request's page: the plan, and the timeline of every run, tool call, test, review and decision](docs/img/item.png)

## What a person does

- **Ask** — the New request form, `/factory …` in Slack, a `factory` label on a Jira/GitHub/Linear
  issue, `/build <project> <what>` on Telegram, `factory new` from a terminal, a webhook, the API.
- **Answer** a question the planner asked (reply in the thread, comment on the ticket, or on the item).
- **Approve or reject** a plan, a merge, a deploy — buttons in Slack and Telegram, a comment of
  `approve`/`reject` on Jira/GitHub/Linear, the board, or `factory approve <id>`.
- **Review** a change: approve or request changes on the PR (or on the item page for local
  delivery). Comments become fix rounds.
- **Unblock**: retry (a stopped build starts a fresh build run on the kept branch; a failed merge
  or deploy goes back to its gate), cancel, skip a gate, mark done, pause an item; admins can pause
  the whole factory.
- **Teach**: write in the book (the twelve newest notes go into every plan and build prompt); set a
  project's instructions; admins tune its gates, limits and tools.

Members ask, answer, comment, retry, cancel, pause an item, write in the book, and edit a
project's words and model. Approving and reviewing follow the "who may approve" setting (members,
or admins only); each chat or ticket source can also name who may decide from there. Admins change
gates, limits, tools and commands, create projects and sources, manage people, and hold the
factory-wide switches, **Pause the factory** included. Viewers only look.

## Projects

A project is a repository plus how to work in it. **Add from this Mac** (admins) lists the git
checkouts one level under rack's roots (`~/Self`, `~/Self/labs`) that are not projects yet, with
the test, build and deploy commands it can read off `package.json`, the `Makefile`, `go.mod` or
`dashboard.json`. Its suggested setup copies the app's `.env` into each worktree so the tests can
reach their database — which means the agent can read that file; leave the copy out for apps
whose secrets it must not see.

| | |
|---|---|
| `repo_url` or `local_path` | a URL the factory clones into `data/repos/<slug>`, or a checkout already on this Mac (`~/Self/me`). Jobs always run in worktrees; a local checkout is only touched by the merge. |
| `delivery` | `pr` (push, open a pull request, merge through GitHub) or `local` (review the diff here, merge into the checkout). |
| `setup_command`, `build_command`, `test_command`, `deploy_command`, `health_url` | run by the factory, not the agent: setup in each new worktree, build and test as the verify gate, deploy after merge. |
| `gates` | `plan` and `merge`: `manual` · `auto` · `auto_low_risk`; `deploy`: `manual` · `auto` · `off`; `review`: `ai` · `off`. With delivery `local` and an automatic merge gate, a verified (and, with `review: ai`, approved) change merges without waiting for a person; with delivery `pr` the pull request still needs its approval. |
| `limits` | `maxTurns`, `maxBudgetUsd` (API-equivalent, as the CLI reports it), `maxMinutes`, `maxFixRounds`, `concurrency`, `verifyMinutes`, `maxInReview` — builds stop starting when that many items of the project are waiting on reviewers — and `observeMinutes` after a deploy. A run that repeats the same tool call four times in a row is stopped as a loop. |
| `tools` | `mode` `readonly` · `edit` · `full`, plus `allow` / `deny` rules in the CLI's syntax (`Bash(docker:*)`). The defaults allow the usual toolchains and deny pushing, `gh`, `sudo`, `ssh`, `docker`, `launchctl`, `kill` and friends. |
| `runner`, `model`, `effort` | which adapter and model does this project's work. |
| `instructions` | appended to every prompt for this project. The repository's own `CLAUDE.md` applies as well. |
| `env` | extra variables for the agent and the commands (names shown, values kept). |

## Sources

| kind | how it gets work | how status goes back |
|---|---|---|
| `manual` / `api` | the form; `POST /api/items` with an API token | the item page, Telegram |
| `slack` | Socket Mode (no public URL needed): an `@mention`, a DM, `/factory <text>` (`/factory status` too), or the source's trigger emoji on a message (`:factory:` by default, a custom emoji you add, or `:robot_face:`); replies in the thread are answers and feedback; 👀 is the factory's acknowledgement | messages in the thread, with Approve / Reject buttons |
| `jira` | polls a JQL every minute (`labels = factory AND statusCategory != Done`); new comments are feedback; `approve` / `reject` comments decide gates | comments on the issue; optional transition when done |
| `github` | polls issues with a label every minute (a token with Issues read & write, or the `gh` login on this Mac); comments are feedback | comments on the issue; PRs are the review surface, always through `gh` |
| `linear` | polls issues with a label | comments |
| `schedule` | cron or interval: the same request each time (nightly log triage, weekly dependency bump); one open at a time | Telegram |
| `watch` | polls a URL and fires on a condition (a 5xx, a JSON number over a threshold, a phrase in the body) — the loop from running software back to work | Telegram |
| `webhook` | `POST /api/hooks/<token>` with `{title, body, …}` from CI, monitoring, anything | Telegram |
| Telegram | `/build <project> <request>`, `/factory`, `/approvals`, through the notifier | the notifier's buttons |

Secrets (tokens) are encrypted at rest with `FACTORY_SECRET`. Set-up details for each are in
[docs/setup.md](docs/setup.md).

## The command line

```
FACTORY_URL=http://127.0.0.1:8282 FACTORY_TOKEN=ft_…   # a token from Settings › My API tokens
factory status                      factory new me "Dark mode for the gym page" --body -
factory ls --open                   factory watch 42        # follow a job live; exit code says how it ended
factory approve 42 "go"             factory review 42 changes "the test only covers the happy path"
factory comment 42 "use the existing Button"   factory cancel 42 · factory retry 42 · factory approvals · factory projects
```

Exit codes: `0` ok, `4` a usage, API or network error. `factory watch` exits by how the item
ended: `0` done, `1` failed, `2` cancelled, `3` blocked (`4` if the CLI or the network gave up
first). Each command refuses flags it does not take; `review … changes` needs a comment;
`factory show --json` carries the whole event history.

## Safety

- One worktree per job; the live checkout of a local project is never written by an agent.
- Agents cannot push, use `gh`, `sudo`, `ssh`, `docker`, `launchctl`, `kill`, or touch the machine; projects widen the allow list deliberately.
- The agent's environment is an allow-list (PATH, HOME, git identity): no database URL, no OAuth secret, no SSH agent, no GitHub token, no API keys unless `CLAUDE_ENV_PASSTHROUGH` names them. The factory itself, not the agent, pushes and opens pull requests.
- What is *not* there: a sandbox. The CLI's file tools are confined to the worktree, but the allowed toolchain commands (`node`, `npm`, `python3`, `make`) run whatever code the repository holds, and an allowed shell command is not path-restricted. The agent therefore has no stored git credentials, no `gh` login, no SSH identity and no API keys (its git talks to nothing), and the factory's own git never runs the repository's hooks. Keep `tools.mode` at `edit`, widen the allow list deliberately, and treat `full` as what it says.
- Projects (what runs on this machine) and sources (integrations and their tokens) are an admin's to create and change; members tune a project's words and model. On GitHub, only owners, members and collaborators of the repository steer the agent through pull-request comments; chat and ticket sources can name who may approve.
- Per run: `maxTurns`, `maxBudgetUsd`, `maxMinutes`, and a loop guard. Per project: concurrency and review WIP. Factory-wide: `MAX_CONCURRENT_RUNS`, a **kill switch** (Settings › Pause), a **daily budget** (nothing new starts once today's API-equivalent spend reaches it), and a hold when the plan's five-hour window is past `usageThreshold` (the CLI reports it on every request).
- A restart marks running sessions interrupted and parks their items as blocked, with the branch and its commits kept; *Retry* starts the stage again from there (a build gets a fresh run on the kept branch; a merge or deploy goes back to its gate; a cancelled item is rebuilt, its branch is gone).
- **Pause the factory** refuses every new agent run at once: a job mid-stage stops at its next run and parks as blocked, to retry after resuming. The **daily budget** only stops the tick: a stage already under way finishes (its day is the database's day).
- Every event has an actor; what people change in projects, sources and people is audited.

## How it is built

| | |
|---|---|
| Server | `server/`, Hono on Node's native TypeScript, Postgres (`factory` in the platform's instance). `lib/pipeline.ts` is the floor: the tick, the stages, the gates, what comes back. `lib/items.ts` the items, approvals, feedback, runs. `lib/runners/` the agent adapters (`claude`, `codex`, `gemini`, `fake`). `lib/sources/` the intake adapters and their scheduler. `lib/git.ts` worktrees, pushes, PRs, merges. `lib/prwatch.ts` reads pull requests back. `lib/conversations.ts` posts status to origins and Telegram. `lib/prompts.ts` every prompt and schema. `lib/auth.ts` Google sign-in, roles, sessions, API tokens. `routes/` the API. |
| Web | `web/`, React + Vite, served by the API: the board, item pages streaming over SSE, projects, sources, people, metrics, the book, settings. |
| CLI | `cli/factory.ts`. |
| Ops | `ops/deploy.sh` (what rack's Deploy button runs), `ops/launchd.sh`, `dashboard.json`. |
| Tests | `test/`: cron, crypto, Google token verification, the stream parser, items, and the whole pipeline end to end on a temporary repository with the fake runner. |
| Docs | [docs/handover.md](docs/handover.md) (state of things and what is left for you), [docs/for-teammates.md](docs/for-teammates.md) (how to ask, answer and approve from every channel), [docs/architecture.md](docs/architecture.md), [docs/setup.md](docs/setup.md), [docs/research/](docs/research/README.md) — the market, the operating model, the headless CLI, the integrations. |
