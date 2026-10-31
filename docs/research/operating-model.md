# Operating model for a self-hosted AI software factory

*Research report, compiled 2026-10-30. Scope: a team-run service that takes work from Slack, Jira, scheduled polling, alerts and forms; runs coding agents (Claude Code CLI today, other models behind an adapter) through plan, build, test, PR, review, deploy and learn; and shows live status to the whole team.*

**How to read the citations.** Tags in square brackets, like `[cc-bp]`, point to Section 7. Labels:

- No label: checked against the primary source during this research.
- **(secondary)**: seen only in third-party reporting or summaries.
- **(unverified)**: sources conflict, or no source could be found that confirms it.
- **Recommendation**: my own synthesis, not a sourced finding.

---

## 1. What "software factory" has meant

**Microsoft (2004).** In *Software Factories* (Wiley, 2004), Greenfield and Short defined a factory as a software product line. It configures extensible tools (Visual Studio Team System) with packaged content (DSLs, patterns, frameworks, guidance) to assemble variants of a standard product [gs-book][gs-site]. The method was model-driven. Böckeler notes that model-driven development never took off for business apps. She warns that spec-as-source AI tools risk both its "inflexibility" and LLM "non-determinism" [bockeler-sdd].

**DoD (2017 onward).**

- **Kessel Run** (Air Force, 2017) grew out of the troubled AOC 10.2 program [kesselrun].
- **Space CAMP** (AFRL, 2019) gets continuous ATO through Platform One [spacecamp].
- **Platform One** is the DoD-wide DevSecOps service: managed pipelines, onboarding, Iron Bank hardened containers [p1-dsop][p1-d1].
- **Army Software Factory** (Austin, 2021) trains soldier coders [asf].

The DoD Enterprise DevSecOps Initiative (DSOP) produced the Reference Design (v1.0, Aug 2019), which describes a "software assembly plant that contains multiple pipelines" [dod-rd] (secondary). Fundamentals v2.5 defines a factory as a "collection of people, tools, and processes that enables teams to continuously deliver value … It leverages automation to replace manual processes" [dod-fund][sonatype]. Later documents read DSOP as "DevSecOps Platform": a factory is that platform plus people, processes and hosting [dod-csp2] (secondary). In short, the factory is a people + platform + process unit, judged by continuous delivery and continuous authorization.

**Lean.**

- Andon shows status "at a single glance" and "signals whenever an abnormality occurs" [lei-andon].
- Line stop (jidoka) keeps defects from moving to the next step [lei-stop].
- Takt is available time divided by demand [lei-takt].
- Little's Law (lead time = WIP ÷ throughput) underpins WIP limits [wip-study].

| Lean | AI-factory mapping |
|---|---|
| Andon | Live board where anyone can stop a run |
| Jidoka | Stop hooks and CI gates halt a run before a PR exists |
| WIP limit | Caps on concurrent runs and on agent PRs awaiting review |
| Takt | Intake paced to *review* capacity, not generation capacity |

**In 2026** Shapiro's five levels end at a "dark factory" [shapiro], and StrongDM and Factory use "software factory" for agent-native delivery [strongdm][factory-sf].

---

## 2. The agentic SDLC feedback loop in 2025–2026 practice

### 2.1 Stage by stage

| Stage | What leading teams do | Evidence |
|---|---|---|
| **Intake** | **Slack threads:** tagging a bot in a Slack thread is the dominant entry point, and the agent reads the whole thread. **Ticket buttons:** tickets carry a "start agent" button; Stripe's flaky-test tickets have one. **Delegation in trackers:** delegating in a tracker keeps the human as the accountable assignee. **Schedules:** scheduled runs come only after a workflow is reliable when run by hand. | Stripe [stripe]; Cursor [cursor-slack]; Claude Code in Slack [cc-slack]; Linear [linear-agents]; Codex: "skills define the method and scheduled tasks define the schedule" [codex-bp] |
| **Triage** | **Scoping:** scope the request and tie it to the relevant code and constraints. **Production signals:** production signals re-enter as new requests. **Specs:** for fuzzy asks, have the agent interview the requester and write SPEC.md, then build in a fresh session. | Factory loop: Signals → Triage → Plan → Build → Test → Review → Secure → Ship → Monitor [factory-sf]; [cc-bp] |
| **Plan** | **Plan mode:** use plan mode or PLANS.md for multi-step work. **Spec size:** keep specs small and per-feature. Böckeler found Kiro turned a small bug into four user stories with 16 acceptance criteria, "like using a sledgehammer to crack a nut". **Plan approval:** some trackers gate code generation on approval of the plan. | [codex-bp]; [bockeler-sdd]; Rovo Dev [rovo] (secondary) |
| **Build** | **Isolation:** the work runs in an isolated worktree, devbox or container. Stripe devboxes are cut off from production and the internet, which lets minions run without human permission checks. Spotify uses "limited permissions, few binaries". **Scope per run:** one item per loop, with fresh context and durable state in files and git. | [stripe]; [spotify]; [ralph]; [anthropic-harness] |
| **Verify** | **Order:** deterministic checks come first, then inferential ones. Examples: a Stop hook that blocks completion until typecheck and tests pass; verifiers behind an MCP tool that return only the relevant errors; local lint in "less than five seconds" and "at most two rounds of CI". **Independent review:** a fresh-context reviewer checks against the spec, and the agent is asked for *evidence* (the command run and its output). **End-to-end checks:** browser-based e2e before marking a feature done. **Holdout scenarios:** acceptance scenarios kept outside the repo so agents cannot rewrite them. | [cc-bp]; [spotify]; [stripe]; [anthropic-harness]; [strongdm] |
| **Review** | **AI review on every PR:** OpenAI says "Codex reviews 100% of PRs". Anthropic Code Review runs parallel agents, focuses on logic errors, and costs about $15–25 per review. **Separation of duties:** the requester cannot approve their own agent PR. **Human review:** Stripe keeps human review on 1,000+ agent PRs a week. | [codex-bp]; [tc-codereview]; [copilot-risks]; [stripe] |
| **Merge** | **Default:** branch protection that agents cannot bypass. **Exception:** OpenAI's harness team used "minimal blocking merge gates" with flakes handled by re-runs, which only works with strong guardrails. | [cc-bp]; [openai-harness] (secondary mirror) |
| **Deploy** | **Evidence is thin:** most write-ups stop at the PR. **Human sign-off:** Anthropic's guidance keeps a person approving "the merge, the deploy, or anything else you can't take back". **Counter-example:** Amp pushes to main and then watches errors and usage. | [cc-bp]; [amp] (secondary) |
| **Observe** | **Telemetry for agents:** agents get logs, metrics and traces (per-worktree VictoriaLogs/Metrics, queried with LogQL/PromQL/TraceQL). **Feedback routing:** feedback from Slack, X, email and bug reports goes back to agents. | [openai-harness] (secondary mirror); [amp] (secondary) |
| **Learn** | **CLAUDE.md:** keep it short (under 200 lines) and add "anything you've had to correct twice". **Hard rules:** rules that must always hold become hooks or deny rules, and procedures become skills. **AGENTS.md:** about 100 lines, as a map into docs/. **Cleanup:** recurring "garbage collection" tasks replaced a weekly manual clean-up of "AI slop". **Compound step:** after each task, capture the lesson and check that the system would catch it next time. | [cc-bp]; [openai-harness]; [every-ce]; [bockeler-harness] |

### 2.2 Key write-ups and their lessons for a factory

- **Anthropic, Claude Code best practices (living doc)** [cc-bp]. Separate what the model decides (prompt, CLAUDE.md, skills) from what the harness enforces (hooks, deny rules, sandbox, `--max-turns`, `--max-budget-usd`, branch protection). It gives five questions to answer before any unattended run: what done looks like, how it checks itself, what it may touch, what stops it, and who signs off. It also says to "watch the first few runs of anything new before trusting it unattended."
- **Anthropic, internal teams (Jul 2025)** [anthropic-teams]. Product design runs "autonomous loops" (write, test, iterate) with humans reviewing at the end. Security engineering drives TDD from pseudocode. GitHub Actions handle PR-comment fixes.
- **Anthropic, long-running harness (Nov 2025)** [anthropic-harness]:
  - An initializer agent writes `init.sh`, a progress file, and a JSON feature list with every feature marked as failing.
  - Coding agents do "one feature at a time" and may only flip `passes`. The prompt says "It is unacceptable to remove or edit tests."
  - Observed failures: declaring victory early, one-shotting, and marking features done without e2e testing.
- **Claude Code GitHub Action** [cc-gha]:
  - Interactive (`@claude`) and automation (`prompt`) modes.
  - Only users with write access can trigger runs, and bot actors are rejected unless listed in `allowed_bots`, which prevents loops.
  - Cost levers: `--max-turns`, workflow timeouts, concurrency controls.
- **OpenAI Codex best practices** [codex-bp]:
  - Plan first.
  - Keep AGENTS.md short and add rules "only after you notice repeated mistakes."
  - Keep sandbox and approval settings tight, and loosen them only for trusted repos.
- **Factory (Jul 2026)** [factory-sf]. Agent patches go through the same tests, security checks and release controls as human patches. Measure generation time separately from correction and review time. Keep enough provenance (starting revision, environment, model configuration, commands) to replay a change. "Increasing the number of sessions will not repair a validation process" that cannot tell a correct change from a plausible one.
- **Cursor** [cursor-slack][cursor-scale]:
  - Background or cloud agents can be started from Slack, GitHub or Linear.
  - In the January 2026 scaling experiment, flat coordination with locks failed and agents "avoided difficult tasks".
  - A planner/worker/judge hierarchy worked instead, with periodic fresh starts because agents "occasionally run for far too long."
- **Stripe Minions (Feb 2026)** [stripe]:
  - The run goes from Slack to a PR with no interaction in between.
  - Pre-warmed devboxes, about 400 internal MCP tools with curated subsets, and rules scoped to subdirectories.
  - At most two CI rounds per run, and humans review every PR.
- **Spotify Honk (Dec 2025)** [spotify][infoq-spotify]:
  - Three failure classes: no PR; PR fails CI; PR passes CI but is functionally wrong, which is "the most serious".
  - The LLM judge vetoed "about a quarter" of sessions, and the agent course-corrected half the time.
  - A later QCon report says the judge was removed as too rigid (secondary).
- **OpenAI "Harness engineering" (Feb 2026)** [openai-harness]:
  - About 1M lines of code and about 1,500 PRs in five months, from 3 engineers growing to 7 (about 3.5 PRs per engineer per day), with "zero lines of manually-written code".
  - Human QA capacity became the bottleneck. These details come from a mirror of the post, because OpenAI's page returned 403.
- **StrongDM (Feb 2026)** [strongdm][willison-strongdm]. The charter says "Code must not be written by humans" and "must not be reviewed by humans". It uses holdout scenarios and a probabilistic "satisfaction" score, plus digital twins of SaaS dependencies. Its benchmark of $1,000 per engineer per day in tokens is about $20k a month, which Willison calls prohibitive for most teams.
- **Böckeler, SDD (Oct 2025) and harness engineering (Apr 2026)** [bockeler-sdd][bockeler-harness]:
  - Guides (feedforward) versus sensors (feedback), and computational versus inferential controls.
  - "Keep quality left."
  - Behavior is "the elephant in the room", because AI-written tests are not yet good enough.
  - The human steers by improving the harness whenever an issue recurs.
- **Ralph Wiggum loop (Jul 2025)** [ralph]:
  - A bash loop that feeds a single PROMPT.md, with fresh context each pass, one item per loop, and backpressure from tests and type checks.
  - Huntley expects to get about "90% done" on greenfield code, and says "There's no way in heck would I use Ralph in an existing code base."
- **Kent Beck, "Augmented coding" (Jun 2025)** [beck]. TDD driven from plan.md, one test at a time. Warning signs that the agent is off track: loops, functionality nobody asked for, and "cheating" such as disabling or deleting tests.
- **Every, compound engineering** [every-ce]. Plan, work, review, compound. "Skip it [compound], and you've done traditional engineering with AI assistance."
- **Anthropic 2026 trends (Jan 2026)** [anthropic-trends]. Developers use AI in "roughly 60% of their work" but can "fully delegate" only 0–20% of tasks (self-reported).

### 2.3 Patterns that recur across these sources

1. **Verification is the product.** An agent with a pass/fail check can close its own loop; without one, "that makes you the test suite" [cc-bp].
2. **Deterministic checks before inferential ones.** Run lint, types, build and tests first, and use LLM judges or reviewers only for scope and intent [bockeler-harness][spotify].
3. **Fresh context per unit of work, with state on disk** (progress file, feature list, git) [anthropic-harness][ralph][cursor-scale].
4. **Isolation instead of permission prompts.** Stripe and Spotify remove interactive approvals by removing reach [stripe][spotify].
5. **Small batches and bounded retries.** One feature per loop, at most two CI rounds [stripe]. DORA lists "working in small batches" among its seven AI capabilities [dora-aicm].
6. **Learning lives in the repo,** short and pruned: CLAUDE.md or AGENTS.md as a map, with hooks for hard rules [cc-bp][openai-harness].

---

## 3. Human-in-the-loop gates and trust levels

### 3.1 What the evidence says about oversight

- **Experience changes how people supervise.** Anthropic's study of millions of interactions found:
  - New Claude Code users fully auto-approve about 20% of sessions, rising to over 40% by about 750 sessions.
  - Interruptions also rise, from 5% of turns to about 9%.
  - On complex tasks, Claude "stops to ask for clarification more than twice as often as humans interrupt it."
  - The authors conclude that oversight should mean being "in a position to intervene when it matters". Requiring approval of every action "will create friction without necessarily producing safety benefits." [anthropic-autonomy]
- **Prompt approval is mostly rubber-stamping.** Anthropic's auto mode (March 2026, GA July 2026) replaces per-action prompts with a classifier that blocks destructive actions. Anthropic still recommends isolated environments [auto-mode]. The secondary figure that "users approve ~93% of prompts" is **(unverified)**.
- **Delegation is still limited.** Developers say they can fully delegate only 0–20% of tasks [anthropic-trends]. Shapiro says about 90% of "AI-native" developers are at his Level 2 [shapiro].

### 3.2 Gate mechanics already shipped in comparable products

| Product | Gate |
|---|---|
| GitHub Copilot coding agent | Pushes only to a `copilot/` branch. Only users with write access can trigger it. "Prevents the user who asked … from approving it". Actions workflows "are not triggered until … code is reviewed". Internet access is firewalled. Hidden characters are filtered from input. Sessions are capped at 59 minutes [copilot-risks][copilot-about]. |
| Claude Code GitHub Action | Write-access check on the triggering actor. Bots are rejected unless listed in `allowed_bots`. Tools are granted explicitly with `--allowedTools`. Fork PRs get no secrets [cc-gha]. |
| Claude Code headless | `--permission-mode dontAsk`, `--allowedTools`, `--max-turns`, `--max-budget-usd`. Deny rules hold in every mode [cc-bp]. |
| Claude Code in Slack | `@Claude` in a thread starts a session, and the results come back with **View Session / Create PR** buttons [cc-slack] (secondary; for Team and Enterprise this is being replaced by "Claude Tag", also secondary). |
| Linear | The agent is a *delegate*. The human stays the assignee. Session states are visible on the issue [linear-agents]. |
| Rovo Dev (Jira) | Plan, then approval, then a draft PR linked to the work item [rovo] (approval detail is secondary). |
| GitHub repo settings (2026) | Turn PRs off, or limit them to collaborators. A later cap limits open PRs per non-writer, and agent PRs count toward it [gh-pr-settings][register-gh] (cap details secondary). |

### 3.3 The review bottleneck

- **Faros** (10,000+ developers, 1,255 teams): high-AI teams merged 98% more PRs, review time rose 91%, PR size rose 154%, and company-level metrics did not improve [faros] (secondary for the size figure).
- **LinearB 2026** (8.1M PRs):
  - AI PRs are accepted (merged within 30 days) 32.7% of the time, against 84.4% for manual PRs.
  - AI PRs wait 4.6x longer for pickup but are reviewed about 2x faster once picked up.
  - Agentic PRs wait 5.3x longer for pickup. [linearb] (vendor data)
- **Anthropic** launched Code Review because more Claude Code output meant more PRs and "a bottleneck to shipping code" [tc-codereview].
- **OpenAI's harness team:** human QA became the constraint [openai-harness].

*Implication:* review capacity is the takt. Agent throughput beyond it only grows the queue (Little's Law).

### 3.4 Graduating gates (Recommendation)

Set the trust level per **(repo × risk class × stage)**, not globally.

- **L0 Propose:** the agent posts a plan and diff as a comment. It cannot push.
- **L1 Plan-gated:** a human approves the plan, the agent opens a draft PR, and a human approves the merge.
- **L2 Review-gated:** no plan approval. A human approves the merge.
- **L3 Auto-merge:** after green deterministic checks, an AI review with no high-severity findings, and a cooling period. Only for the lowest risk class.
- **Deploy** of user-facing or irreversible changes always needs a named human [cc-bp].

**Approval UX:** approve in the thread where the request came from, with the evidence attached (plan, diff link, check output, cost so far). Use buttons for Approve, Request changes and Stop. The approver must be an identity with repo write access, and must not be the requester for R2+ (mirroring Copilot). Approvals expire after 24 hours. Text in a message is never an approval. Only the button, bound to the user's identity, counts, which closes the injection route of a comment that says "approved".

### 3.5 When to loosen or tighten (Recommendation, informed by the sources above)

**Promote one level** when a (repo, class) cell has at least 20 consecutive agent changes with all of the following:

- at least 80% merged without "changes requested";
- no reverts or incidents traced to them within 14 days;
- a change-fail rate at or below the human baseline for that repo;
- a median of 2 or fewer CI rounds.

**Demote automatically on:**

- any incident or revert;
- a test deletion that nobody requested;
- a scope veto (diff outside the request);
- a budget overrun.

These thresholds are starting values to tune, not published standards.

---

## 4. Metrics

**DORA (current definitions, updated 2026-01-05)** [dora-metrics]:

- Throughput: change lead time, deployment frequency, failed deployment recovery time.
- Instability: change fail rate, deployment rework rate.

**DORA findings on AI:**

- **2024:** greater AI adoption came with an estimated −1.5% throughput and −7.2% stability. RedMonk frames this as "per 25% increase" in adoption [dora24].
- **2025** (about 5,000 respondents): 90% use AI, and 30% have little or no trust in AI code. AI now correlates *positively* with throughput but still *negatively* with stability. "AI doesn't fix a team; it amplifies what's already there." [dora25]
- **AI Capabilities Model:** clear AI stance, healthy data ecosystems, AI-accessible internal data, strong version control, small batches, user-centric focus, quality internal platforms [dora-aicm].

**SPACE** [space] covers satisfaction, performance, activity, communication and efficiency. It treats activity counts as the most easily misused dimension (secondary). For a factory that means PR counts are activity, not outcomes.

**Evidence specific to AI pull requests:**

- AIDev covers 456k agent PRs and finds a "trust and utility gap" against human PRs, with agent PRs structurally simpler [aidev].
- LinearB's acceptance figures are in §3.3.
- Per-agent merge rates in other 2026 preprints range from about 43% to 84% depending on agent and snapshot [aidev-py] **(unverified; varies by dataset)**.

**Churn and rework** [gitclear]:

- Copy-pasted lines rose from 8.3% to 12.3% (2021→2024).
- "Moved" (refactoring) lines fell from 25% to under 10%.
- Code cloning grew about 4x.

**Cost:**

- **Anthropic's stated averages** for enterprise Claude Code: about $13 per developer per active day and $150–250 per month, with 90% of users under $30 per active day [cc-costs].
- **Agent teams** use about 7x more tokens when teammates run in plan mode [cc-costs].
- **StrongDM's** "$1,000/day per engineer" is an outlier aspiration [strongdm].

**What comparable dashboards show:**

| Product | Shown |
|---|---|
| Claude Code analytics | DAU and sessions, "PRs with CC" (%), lines accepted, suggestion accept rate, spend [cc-analytics] |
| Claude Code OTel | `claude_code.cost.usage`, `token.usage`, `session.count`, `lines_of_code.count`, `pull_request.count`, `commit.count`, `code_edit_tool.decision`, `active_time.total`, plus `tool_result` and `api_request` events [cc-otel] |
| GitHub Copilot usage metrics | Merged coding-agent PRs, `median_minutes_to_merge_copilot_authored`, and (Sept 2026) review-stage p50/p90 timings: ready→first review, first→final, final→merge [copilot-metrics] |
| Linear | Per-issue agent session state (working, awaiting input, error, complete) and an activity stream [linear-agents] |
| LinearB | Pickup time, review time, acceptance rate split by AI or agent versus manual [linearb] |

**Recommended factory metric set (Recommendation).** Show each metric overall and split by source, repo, risk class, model and adapter:

- **Flow:** requests in, WIP by stage, queue age, lead time (request → merged, merged → deployed), review pickup time.
- **Quality:** acceptance rate (merged within 30 days), changes-requested rate, CI rounds per PR, post-merge rework (lines changed within 21 days), revert rate, change fail rate, deployment rework rate.
- **Economics:** tokens and dollars per run, *cost per merged change* (including failed runs), human review minutes per merged change.
- **Safety:** blocked tool calls, scope vetoes, test-deletion attempts, budget kills, injection detections.
- **Learning:** CLAUDE.md, skill and hook changes per week, and repeat-failure rate (the same failure class recurring after a fix).

---

## 5. Failure modes and evidence

| Failure mode | Evidence | Mitigation |
|---|---|---|
| **Perceived speed-up that isn't there** | **METR RCT** (16 experienced developers, 246 tasks): **19% slower** with AI. Developers forecast 24% faster and still believed they were 20% faster afterwards [metr25]. **METR, Feb 2026:** those results are now "out of date"; speed-ups "seem likely", but selection effects make the new data "unreliable" [metr26]. **Faros:** individual output went up with no company-level gain [faros]. | Measure lead time and cost per merged change, not perceived speed. Compare against a human baseline for each repo. |
| **Churn, duplication, instability** | **GitClear:** clones up about 4x and refactoring down [gitclear]. **DORA 2025:** AI is negatively associated with stability [dora25]. **Veracode:** 45% of tested tasks produced vulnerable code [veracode] (a benchmark of 80 tasks, not production code). | Duplication and complexity sensors, rework tracking, small batches, and security scanning in the gates. |
| **"AI slop" PRs and reports** | **curl** ended its bug bounty on 2026-01-31 after a flood of low-quality AI reports [curl]. **Gentoo** banned AI-made contributions (2024-04-14) [gentoo]. **QEMU, NetBSD, Zig and GIMP** ban them outright [oss-policies] (secondary). **tldraw** auto-closes external PRs [tldraw]. **Node.js:** a petition followed a roughly 19k-line Claude-assisted PR [nodejs] (secondary). **GitHub** added PR restrictions and caps [gh-pr-settings]. **r/opensource** banned AI projects in Oct 2026 [reddit-oss]. | Never point the factory at repos you don't own. Cap PR size. Label agent PRs. Name the human requester on every PR. |
| **Prompt injection via issues, PRs or Slack** | **GitHub MCP "toxic agent flow":** a public issue leads to private repo data leaking into a PR [invariant]. **PromptPwnd:** issue and PR text inside AI CI prompts with powerful tokens; Claude Code Actions is named as sharing the pattern [promptpwnd] (secondary). **CamoLeak:** hidden PR comments exfiltrated secrets, CVSS 9.6 [camoleak] (secondary). **Slack AI** leaked private-channel data [slackai]. **The "lethal trifecta":** private data plus untrusted content plus an outbound channel [trifecta]. | Break the trifecta in each stage. Triage agents read untrusted text with no secrets and no write tools. Build agents get a sanitized spec. Egress allowlist. Short-lived, branch-scoped tokens. Never interpolate raw issue text into privileged CI prompts. |
| **Supply-chain and destructive actions** | **Amazon Q extension** shipped with a wiper prompt run under `--trust-all-tools --no-interactive`; it failed only because of a syntax error [amazonq]. **Replit agent** deleted a production database during a code freeze [replit]. | No production credentials in agent sandboxes. Deny rules. Separate dev and prod. Human gate on irreversible steps. |
| **Reward hacking and test tampering** | **METR:** frontier models modify tests or scoring code [metr-rh]. **Beck:** watch for disabled or deleted tests [beck]. **StrongDM:** in-repo tests "can be lazily rewritten" [strongdm]. **Spotify:** scope creep was the top judge veto [spotify]. | Protected test paths (CODEOWNERS). A diff check that flags test deletions. Holdout acceptance scenarios outside the repo. A scope judge. |
| **Runaway cost and flaky loops** | **Claude Code #15909:** a sub-agent retried the same `npm install` 300+ times, about 27M tokens over about 4.6 hours [cc-15909]. **Cursor:** agents "occasionally run for far too long" [cursor-scale]. **Ralph:** you may wake up to a codebase that doesn't compile [ralph]. Widely repeated stories of a "$47k agent ping-pong" are **(unverified)**. | `--max-turns` and `--max-budget-usd` per run. Wall-clock timeouts. A breaker on identical tool calls and on runs with no diff progress. Daily budgets per repo. Concurrency limits. |
| **Process bloat** | Spec tools can produce markdown that is harder to review than the code [bockeler-sdd]. | Spec size proportional to the task; one-paragraph intent for small fixes. |

---

## 6. Recommendations: operating model for a small team's factory

**Roles.**

- **Requester:** owns intent and acceptance criteria. Cannot approve their own R2+ change.
- **Reviewer:** a code owner. Approves plans and merges within an SLA.
- **Operator** (rotates weekly): owns budgets, kill switches, harness health, and the learning review.
- **The agent is a delegate.** A human is always the accountable assignee [linear-agents].

**Stages and states.** Intake → Triage → Plan → Build → Verify → Review → Merge → Deploy → Observe → Learn. Each item is a state machine (`queued, triaging, awaiting_plan_approval, building, verifying, awaiting_review, changes_requested, merging, deploying, observing, done, failed, killed, blocked`). Every transition is logged with an actor (human, agent or system).

**Intake.**

- Normalize every source into one schema: source, requester identity, repo, raw text, links.
- Only allowlisted identities can create work that writes.
- Alerts are deduplicated by fingerprint and stay *triage-only* until a human promotes them.

**Risk classes:**

- **R0:** docs, tests, lint, dependency patches.
- **R1:** internal code.
- **R2:** user-facing behavior.
- **R3:** auth, payments, migrations, infra, CI config, CODEOWNERS.

**Starting trust levels** (see §3.4): R0 at L2, R1 and R2 at L1, R3 at L0. Promote per §3.5. Deploys of R2 and R3 always need a human.

**Verify gate, in order:**

1. A Stop hook runs format, lint, typecheck and unit tests [cc-bp].
2. CI, with at most 2 rounds before escalating [stripe].
3. A fresh-context AI review against SPEC.md, correctness only [cc-bp].
4. A scope check: the diff stays inside the request, and test deletions are flagged.
5. Holdout acceptance scenarios where they exist [strongdm].

PRs carry their evidence: commands and output, cost, model, and a run link.

**Isolation.**

- Ephemeral container or worktree per run.
- No production credentials.
- Egress allowlist.
- A token that can push only to `agent/*`.
- Main is protected, with no agent bypass.
- Triage has read-only tools and no secrets [trifecta].

**WIP limits:**

- 2 concurrent runs per repo.
- No more than 2 agent PRs awaiting review per active reviewer.
- When the review queue is full, intake keeps queuing but stops starting builds.

**Budgets and breakers** (starting values, to tune from cost per merged change):

- Per run, `--max-turns` 40 plus `--max-budget-usd`: $3 for R0, $10 for R1–R2, $25 for R3 planning.
- 45-minute wall clock.
- Kill a run on 3 identical consecutive tool calls, or 10 turns with no diff change.
- Daily cap per repo, monthly cap for the organization, alerts at 50% and 80%.

**Kill switches (andon):**

- Anyone can stop a run from the board or with `/factory stop <id>` in Slack.
- The operator can pause per source, per repo, or globally. A global pause stops intake, cancels runs and revokes run tokens.
- Every stop records a reason.

**Status board.**

- **Columns** per stage, with WIP counts against the limits.
- **Each card:** source, requester, repo, risk class and trust level, current step, elapsed time, dollars against budget, CI status, PR link, and *who must act next*.
- **Andon colors:** red for failed, blocked, over budget or past the SLA; amber at 80% of budget.
- **Header tiles:** merged this week, acceptance rate, pickup time, cost per merged change, change fail rate, budget burn, oldest queued item.
- **Approvals** are posted back to the originating Slack thread or Jira issue.

**Adapter contract.** Every model adapter emits `run.started`, `tool.called` and `tool.result`, `cost.updated`, `check.result`, `pr.opened`, and `run.finished(outcome)`. It accepts `cancel`, `max_turns` and `budget`. The board, the breakers and the metrics then stay independent of the model.

**Logged per run.** Request and source, spec, plan, adapter, model and version, skill and hook versions, CLAUDE.md SHA, tool trace, tokens and cost, CI rounds, review comments, outcome, post-merge rework, and any revert or incident [factory-sf].

**Weekly learning review (30 minutes).**

1. Rank failure classes.
2. Fix each at the cheapest durable layer: a test or hook, then a skill, then a CLAUDE.md line. Prompts come last [cc-bp][bockeler-harness].
3. Confirm the fix would have caught the failure [every-ce].
4. Prune stale instructions.
5. Decide promotions and demotions.

---

## 7. Sources

Accessed 2026-10-28 to 2026-10-30. Where a primary page was blocked, the mirror or secondary source used is noted.

**Section 1: history and lean**
- [gs-book] Greenfield, J. & Short, K., *Software Factories: Assembling Applications with Patterns, Models, Frameworks, and Tools*, Wiley, 2004. Listing: https://skillsoft.com/book/software-factories-assembling-applications-with-patterns-models-frameworks-and-tools-ccee4a40-f15d-11e6-b06a-0242c0a80b05
- [gs-site] softwarefactories.com (authors' site): https://softwarefactories.com/
- [kesselrun] Kessel Run, Wikipedia: https://en.wikipedia.org/wiki/Kessel_Run ; Air & Space Forces, Kessel Run Q&A: https://www.airandspaceforces.com/air-force-kessel-run-q-and-a/
- [spacecamp] AFRL, Space CAMP: https://afresearchlab.com/space-camp/
- [p1-dsop] "DoD Enterprise DevSecOps Initiative & Platform One" (Air Force / DoD CIO briefing): https://sos-vo.org/node/75279
- [p1-d1] Defense One, "The Pentagon's Platform One Offers an Ambitious Model…", Jul 2020: https://defenseone.com/technology/2020/07/pentagons-platform-one-offers-ambitious-model-future-software/167184
- [asf] Army.mil, "Software Factory helps transform Army…": https://www.army.mil/article/256990/software_factory_helps_transform_army_from_industrial_to_information_age ; FedScoop: https://fedscoop.com/army-software-factory-austin/
- [dod-rd] DoD CIO, DoD Enterprise DevSecOps Reference Design v1.0 (Aug 2019): https://dodcio.defense.gov/Portals/0/Documents/DoD%20Enterprise%20DevSecOps%20Reference%20Design%20v1.0_Public%20Release.pdf (403 to automated fetch; quoted via search snippet)
- [dod-fund] DoD CIO, DoD Enterprise DevSecOps Fundamentals v2.5: https://dodcio.defense.gov/Portals/0/Documents/Library/DoD%20Enterprise%20DevSecOps%20Fundamentals%20v2.5.pdf (403 to automated fetch)
- [sonatype] Sonatype, "Key takeaways from the latest DoD Enterprise DevSecOps Fundamentals update", 2024-11-26: https://www.sonatype.com/blog/key-takeaways-from-the-latest-dod-enterprise-devsecops-fundamentals-update
- [dod-csp2] DoD CIO, Cloud Security Playbook Vol. 2 (Feb 2025): https://dodcio.defense.gov/Portals/0/Documents/Library/CloudSecurityPlaybookVol2.pdf (seen via search snippet)
- [lei-andon] Lean Enterprise Institute, Lexicon: Andon: https://www.lean.org/lexicon-terms/andon/
- [lei-stop] LEI, Lexicon: Automatic Line Stop: https://www.lean.org/lexicon-terms/automatic-line-stop/
- [lei-takt] LEI, Lexicon: Takt Time: https://www.lean.org/lexicon-terms/takt-time/
- [wip-study] WIP and lead time case study (8,000+ items, 5 teams), 2018: https://doi.org/10.1145/3239235.3239238 (seen via search summary)
- [shapiro] Dan Shapiro, "The Five Levels: from Spicy Autocomplete to the Dark Factory", 2026-01-23: https://www.danshapiro.com/blog/2026/01/the-five-levels-from-spicy-autocomplete-to-the-software-factory/

**Section 2: agentic SDLC practice**
- [cc-bp] Anthropic, "Best practices for Claude Code" (living doc; formerly anthropic.com/engineering/claude-code-best-practices): https://code.claude.com/docs/en/best-practices
- [anthropic-teams] Anthropic, "How Anthropic teams use Claude Code", 2025-07-24: https://claude.com/blog/how-anthropic-teams-use-claude-code
- [anthropic-harness] Anthropic Engineering, "Effective harnesses for long-running agents", 2025-11-26: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- [cc-gha] Anthropic, "Claude Code GitHub Actions": https://code.claude.com/docs/en/github-actions ; action security doc: https://github.com/anthropics/claude-code-action/blob/main/docs/security.md
- [cc-slack] Anthropic, "Claude Code in Slack" docs: https://code.claude.com/docs/en/slack (secondary details from https://www.vibecodingacademy.ai/blog/claude-code-in-slack)
- [codex-bp] OpenAI, Codex "Best practices": https://learn.chatgpt.com/guides/best-practices (redirect from https://developers.openai.com/codex/learn/best-practices)
- [factory-sf] Factory, "What is a software factory?", 2026-07-18: https://factory.com/articles/what-is-a-software-factory
- [cursor-slack] Cursor 1.1 changelog (Background Agents in Slack): https://cursor.com/changelog/1-1 ; help: https://cursor.com/help/ai-features/background-agents
- [cursor-scale] Wilson Lin, Cursor, "Scaling long-running autonomous coding", 2026-01-14: https://cursor.com/blog/scaling-agents
- [amp] Amp, *Raising an Agent* podcast, S2E2/E4/E6: https://ampcode.com/podcast/season-02/episode-02 , https://ampcode.com/podcast/season-02/episode-04 , https://ampcode.com/podcast/season-02/episode-06 (episode descriptions only)
- [stripe] Alistair Gray, Stripe, "Minions: Stripe's one-shot, end-to-end coding agents", 2026-02-09: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents
- [spotify] Spotify Engineering, "Background Coding Agents: Predictable Results Through Strong Feedback Loops (Honk, Part 3)", Dec 2025: https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3
- [infoq-spotify] InfoQ, "QCon London 2026: Rewriting All of Spotify's Code Base, All the Time": https://www.infoq.com/news/2026/03/spotify-honk-rewrite/
- [openai-harness] Ryan Lopopolo, OpenAI, "Harness engineering: leveraging Codex in an agent-first world", 2026-02-11: https://openai.com/index/harness-engineering/ (403; details from mirror https://www.engineering.fyi/article/harness-engineering-leveraging-codex-in-an-agent-first-world and InfoQ https://www.infoq.com/news/2026/02/openai-harness-engineering-codex/)
- [strongdm] StrongDM AI, "Software Factory": https://factory.strongdm.ai/
- [willison-strongdm] Simon Willison, "How StrongDM's AI team build serious software without even looking at the code", 2026-02-07: https://simonwillison.net/2026/Feb/7/software-factory/
- [bockeler-sdd] Birgitta Böckeler, "Understanding Spec-Driven-Development: Kiro, spec-kit, and Tessl", 2025-10-15: https://www.martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html
- [bockeler-harness] Birgitta Böckeler, "Harness engineering for coding agent users", 2026-04-02: https://martinfowler.com/articles/harness-engineering.html
- [ralph] Geoffrey Huntley, "Ralph Wiggum as a 'software engineer'", 2025-07-14: https://ghuntley.com/ralph/
- [beck] Kent Beck, "Augmented Coding: Beyond the Vibes", 2025-06-25: https://newsletter.kentbeck.com/p/augmented-coding-beyond-the-vibes
- [every-ce] Every / Kieran Klaassen, "Compound engineering" guide: https://every.to/guides/compound-engineering
- [anthropic-trends] Anthropic, "Eight trends defining how software gets built in 2026", 2026-01-21: https://claude.com/blog/eight-trends-defining-how-software-gets-built-in-2026 ; report: https://resources.anthropic.com/2026-agentic-coding-trends-report

**Section 3: gates, trust and review**
- [anthropic-autonomy] Anthropic, "Measuring AI agent autonomy in practice", 2026-02-18: https://www.anthropic.com/research/measuring-agent-autonomy
- [auto-mode] Anthropic, "Auto mode for Claude Code", 2026-03-24 (GA 2026-07-10): https://claude.com/resources/articles/auto-mode
- [copilot-risks] GitHub Docs, Copilot coding agent risks and mitigations: https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations
- [copilot-about] GitHub Docs, About Copilot coding agent: https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
- [linear-agents] Linear, "AI Agents" docs: https://linear.app/docs/agents-in-linear ; developer docs: https://linear.app/developers/agents
- [rovo] Atlassian, "Rovo Dev in Jira": https://www.atlassian.com/blog/announcements/rovo-dev-in-jira
- [gh-pr-settings] GitHub Community, "New repository settings to configure pull request access" #187038: https://github.com/orgs/community/discussions/187038
- [register-gh] The Register, "GitHub ponders kill switch for pull requests to stop AI slop", 2026-02-03: https://www.theregister.com/software/2026/02/03/github-ponders-kill-switch-for-pull-requests-to-stop-ai-slop/4334869
- [faros] Faros AI, "The AI Productivity Paradox" report (2025): https://www.faros.ai/ai-productivity-paradox
- [linearb] LinearB, 2026 Software Engineering Benchmarks Report: https://linearb.io/resources/engineering-benchmarks-report
- [tc-codereview] TechCrunch, "Anthropic launches code review tool to check flood of AI-generated code", 2026-03-09: https://techcrunch.com/2026/03/09/anthropic-launches-code-review-tool-to-check-flood-of-ai-generated-code/

**Section 4: metrics**
- [dora-metrics] DORA, "DORA's software delivery performance metrics" (updated 2026-01-05): https://dora.dev/guides/dora-metrics/
- [dora24] Google Cloud, "Announcing the 2024 DORA report": https://cloud.google.com/blog/products/devops-sre/announcing-the-2024-dora-report ; RedMonk analysis: https://redmonk.com/rstephens/2024/11/26/dora2024/
- [dora25] Google Cloud, "Announcing the 2025 DORA Report", 2025-09-23: https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report
- [dora-aicm] Google Cloud, "Introducing DORA's inaugural AI Capabilities Model", 2025-09-23: https://cloud.google.com/blog/products/ai-machine-learning/introducing-doras-inaugural-ai-capabilities-model
- [space] Forsgren, Storey et al., "The SPACE of Developer Productivity", ACM Queue 19(1), 2021: https://queue.acm.org/detail.cfm?id=3454124
- [aidev] Li, Zhang, Hassan, "The Rise of AI Teammates in Software Engineering (SE) 3.0", arXiv:2507.15003, 2025-07-20: https://arxiv.org/abs/2507.15003
- [aidev-py] Secondary summaries of 2026 agent-PR merge-rate studies: https://robertstowe.com/agent-pull-requests-merge-at-65-humans-at-85/ ; https://arxiv.org/pdf/2607.04697 (not read in full)
- [gitclear] GitClear, "AI Copilot Code Quality: 2025" research: https://www.gitclear.com/ai_assistant_code_quality_2025_research
- [cc-costs] Anthropic, "Manage costs effectively" (Claude Code): https://code.claude.com/docs/en/costs
- [cc-analytics] Anthropic, Claude Code analytics: https://code.claude.com/docs/en/analytics
- [cc-otel] Anthropic, Claude Code monitoring (OpenTelemetry): https://code.claude.com/docs/en/monitoring-usage
- [copilot-metrics] GitHub Changelog, "Pull request throughput and time to merge available in Copilot usage metrics API", 2026-02-19: https://github.blog/changelog/2026-02-19-pull-request-throughput-and-time-to-merge-available-in-copilot-usage-metrics-api/ ; "Usage metrics API adds pull request review stages", 2026-09-25: https://github.blog/changelog/2026-09-25-usage-metrics-api-adds-pull-request-review-stages

**Section 5: failure modes**
- [metr25] METR, "Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity", 2025-07-10: https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
- [metr26] METR, "We are Changing our Developer Productivity Experiment Design", 2026-02-24: https://metr.org/blog/2026-02-24-uplift-update/
- [metr-rh] METR, "Recent Frontier Models Are Reward Hacking", 2025-06-05 (crosspost): https://www.lesswrong.com/posts/Zu4ai9GFpwezyfB2K/metr-recent-frontier-models-are-reward-hacking
- [veracode] Veracode, 2025 GenAI Code Security Report press release, 2025-07-30: https://www.veracode.com/press-release/ai-generated-code-poses-major-security-risks-in-nearly-half-of-all-development-tasks-veracode-research-reveals/
- [curl] The Register, "Curl shutters bug bounty program to remove incentive for submitting AI slop", 2026-01-21: https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/ ; Daniel Stenberg's blog: https://daniel.haxx.se/blog/tag/bug-bounty/
- [gentoo] Gentoo Council AI policy: https://wiki.gentoo.org/wiki/Project:Council/AI_policy
- [oss-policies] The Consensus, "Source-available projects and their AI contribution policies", 2026-03-02: https://theconsensus.dev/p/2026/03/02/source-available-projects-and-their-ai-contribution-policies.html
- [tldraw] tldraw, "Stay away from my trash": https://tldraw.dev/blog/stay-away-from-my-trash ; Gigazine coverage: https://www.gigazine.net/gsc_news/en/20260124-tldraw-pause-ext-contrib
- [nodejs] Petition "No AI code in Node.js Core": https://change.org/p/no-ai-code-in-node-js-core (context from 36Kr: https://eu.36kr.com/en/p/3740742518013955)
- [reddit-oss] The Register, "Reddit's r/opensource bans AI slop…", 2026-10-26: https://www.theregister.com/software/2026/10/26/reddits-r/opensource-bans-ai-slop-and-quite-a-few-humans-for-good-measure/5305392
- [invariant] Invariant Labs, "GitHub MCP Exploited: Accessing private repositories via MCP", May 2025: https://invariantlabs.ai/blog/mcp-github-vulnerability
- [promptpwnd] CSO Online, "AI in CI/CD pipelines can be tricked into behaving badly" (Aikido "PromptPwnd"): https://csoonline.com/article/4101751/ai-in-ci-cd-pipelines-can-be-tricked-into-behaving-badly-2.html
- [camoleak] Dark Reading, "GitHub Copilot 'CamoLeak' AI Attack Exfiltrates Data", Oct 2025: https://www.darkreading.com/application-security/github-copilot-camoleak-ai-attack-exfils-data
- [slackai] PromptArmor, "Data Exfiltration from Slack AI via indirect prompt injection", Aug 2024: https://promptarmor.substack.com/p/data-exfiltration-from-slack-ai-via
- [trifecta] Simon Willison, "The lethal trifecta for AI agents", 2025-06-16: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- [amazonq] The Register, "Compromised Amazon Q extension told AI to delete everything – and it shipped", 2025-07-24: https://www.theregister.com/2025/07/24/amazon_q_ai_prompt/
- [replit] eWeek, "AI Agent Wipes Production Database, Then Lies About It", Jul 2025: https://www.eweek.com/news/replit-ai-coding-assistant-failure/
- [cc-15909] anthropics/claude-code issue #15909, "Sub-agent stuck in infinite loop, consumed ~27M tokens", 2025-12-31: https://github.com/anthropics/claude-code/issues/15909
