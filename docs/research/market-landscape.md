# Software Factories & Autonomous AI Software-Delivery Platforms — Market Landscape

*Research date: 2026-10-30. Scope: products that take in work (tickets, Slack messages, issues, specs, schedules) and deliver software (PRs, deployments) with AI agents, show status, and close a feedback loop. Figures are vendor-reported unless marked otherwise. "Unverified" = I could not confirm against a primary source. "Secondary" = third-party blog/aggregator.*

---

## 1. Executive summary

"Software factory" is a crowded, consolidating category ([Ostrovsky, Sep 2026](https://igoro.com/archive/software-factories/)). Five findings:

1. **The basic loop is now standard.** Every major vendor takes work from Slack, Linear, Jira or GitHub issues and runs it in a cloud sandbox. It posts status back to the thread the request came from and returns a PR. Competition has moved to what follows the PR: auto-fixing CI and review comments, verification evidence, risk-tiered review, governance.
2. **Products are churning.** Windsurf became Devin Desktop and SpaceX bought Cursor (Aug 2026). ClickUp absorbed Codegen, and Harness bought Augment's Cosmos (Oct 2026). Rovo Dev's standalone product is reaching end of life, Q Developer's IDE plugins lose support in Apr 2027, and Sweep has pivoted away.
3. **Seats are giving way to usage credits,** so cost per merged PR is the metric that matters. No vendor publishes it, or a first-attempt merge rate.
4. **Evidence is thin.** SWE-bench Verified is retired because of contamination, and the best public SWE-bench Pro scores are about 58–59%. METR's 2026 follow-up was inconclusive. DORA 2025 finds higher throughput but rising instability. Agent-PR merge rates (43–83%) are heavily confounded.
5. **There is room for a small self-hosted factory.** The openings are intake that works with any tracker or git host, full PR babysitting including merge conflicts, per-task cost and merge telemetry, and strict sandboxing. The model adapter belongs at the harness level, because Anthropic does not support Claude Code on non-Claude models and bars third-party products from using subscription logins.

---

## 2. Landscape table

Legend: **Cat.** = cloud agent (CA), IDE/CLI agent (IDE), orchestration platform (PLAT), app builder (APP), enterprise batch (ENT). Pricing is entry/representative as of Oct 2026.

| Product (vendor) | Cat. | Intake channels | Where work runs | Feedback loop (status → review/CI → agent) | Team features | Model flexibility | Pricing (entry → top) | Reported performance / key weakness |
|---|---|---|---|---|---|---|---|---|
| **Droids** (Factory) | PLAT+IDE | CLI, IDE, desktop/web/mobile app, Slack, Linear, Jira, API, Automations | Local; Factory "Droid Computers" (cloud); on-prem/air-gapped (Ent.) | Cloud session sync; Automations for review/QA/incident; Workstreams orchestrator | Teams ≤10 seats; Business SSO/SCIM, audit, autonomy & model policy | Multi-vendor + BYOK (OpenRouter, Ollama); only Anthropic/OpenAI official APIs "fully tested" | Pro $20 → Max $200; Teams $60 + $40/seat | Terminal-Bench leader claims (self-reported); opaque rolling limits |
| **Devin** + Devin Desktop (Cognition) | CA+IDE | Web, Slack, Teams, Jira, Linear, GitHub `/devin`, GitLab, Bitbucket, Azure DevOps, API | Cognition cloud VMs; dedicated/VPC (Ent.) | Session transcript, PRs, PR-comment iteration, DeepWiki/Devin Review | Teams ≤200 users; Ent. SSO, VPC, teamspaces | Frontier models from OpenAI, Anthropic, Google, SpaceXAI + own SWE-2 | Free; Pro $20 → Max $200; Teams $80 + $40/seat | Self-reported merge rate 34→67%; weak on ambiguity and mid-task changes |
| **Codex** cloud (OpenAI) | CA+IDE | Web, desktop, mobile, CLI, IDE, Slack `@Codex`, Linear (assign/mention/triage rules), GitHub PR review, SDK/Action | OpenAI-managed per-task containers; local CLI | Diff + logs in task; follow-ups; human opens PR; `@codex` review on GitHub; Linear activity updates | Shared environments; Business/Ent. admin, SCIM | OpenAI models only in cloud | Plus $20; Pro $100/$200/$500; Business $20–25/user | Highest merge rate in AIDev data (82.6%), but human pre-filters PRs; GitHub-only cloud |
| **Claude Code** (Anthropic): CLI, cloud/web, GH Action, Agent SDK, Slack/Claude Tag | IDE+CA | CLI, `claude --cloud`, web/mobile, Slack `@Claude`, Claude Tag (org identity), GitHub Action (`@claude`, events, cron), GitLab CI, cloud scheduled tasks (cron/API/GitHub events), Channels | Local; Anthropic VMs; self-hosted runners (Team/Ent.); CI runners | Slack thread progress → View Session/Create PR; diff comments; **Auto-fix PR** (CI failures + review comments); Code Review on every PR | Team-visible sessions, org-shared environments, admin roles, analytics | Claude only; via Anthropic API, Bedrock, Google Cloud, Foundry; gateways allowed, non-Claude models not supported | Pro $20; Max $100; Ultra $200; Team $25/$125 seats; Ent. $20/seat + API usage | Run-rate >$2.5B (Feb 2026); usage-limit complaints; cloud is GitHub-only |
| **Copilot cloud agent** (GitHub) | CA | Assign issue, Agents tab, VS Code, CLI, mobile, Slack, Teams, Linear, Azure Boards, Jira (GA Jun 2026), code-scanning alerts, Agentic Workflows | GitHub Actions runner (1 repo, 59-min cap; self-hosted OK) or new cloud sandbox (multi-repo) | Draft PR + session logs; `@copilot` follow-ups; Copilot code review; Agent Merge fixes failed checks/conflicts | Org policies, branch rules, shared sessions | Multi-vendor picker; Agent HQ runs Claude & Codex agents (preview) | Pro $10 → Max $100; Business $19; Ent. $39 + Actions minutes | 43% merged in AIDev data; only 6.2% for fully autonomous PRs |
| **Cursor cloud agents** + Automations + Bugbot (Anysphere/SpaceX) | IDE+CA | Desktop, web, iOS/Android, Slack, GitHub/Bitbucket `@cursor`, Linear, API; Automations: cron, Slack, Linear, GitHub, GitLab, Sentry, PagerDuty, webhooks | Cursor VMs; "Self-Hosted Machines" for tool execution | PRs with screenshots/video/logs; take over remote desktop; Bugbot review → Autofix spawns agent | Teams pooled usage; Ent. SCIM, audit | Grok-first since the SpaceX bundle; third-party models at API price (Premium+) | Premium $30 (cheapest with cloud agents) → Ultra $200; Teams $30+/user | ARR ~$3B (May 2026); repeated pricing upheaval; vendor control change |
| **Jules** (Google) | CA | Web, `jules` label on GitHub issue, Jules Tools CLI, REST API (v1alpha) | Google Cloud VM | Plan approval → diff → PR | Weak; paid tiers reportedly individual-only (unverified) | Gemini only | Free 15 tasks/day; Pro 100/day; Ultra 300/day | GitHub-only; struggles with vague tasks |
| **Kiro** (AWS); Q Developer sunsetting | IDE+CA | Kiro IDE/CLI; Kiro Web (preview), `/kiro fix` on GitHub issues/PRs; Jira/Slack announced for autonomous agent | AWS sandbox (us-east-1 in preview) | Activity feed; bot replies on issue with session link; `/kiro fix` applies review comments; collaborative vs autonomous mode | Ent. via AWS IAM Identity Center | Auto router + Claude, GPT-5.6, open-weight (DeepSeek, GLM, Qwen, MiniMax) | Free 50 credits; Pro $20 → Power $200; $0.04/credit overage | Preview only; about one PR per session; MCP servers run outside sandbox |
| **Rovo Dev** (Atlassian) | IDE+review | Jira work items, CLI, VS Code, Bitbucket Pipelines, GitHub/Bitbucket review | Local CLI / CI | Code Reviewer checks Jira acceptance criteria | Jira-site based | Unnamed "frontier models" | Standard $20/dev with 2,000 credits; $0.01/credit | **Standalone EOL announced** (date TBA); folding into Jira |
| **GitLab Duo Agent Platform** | PLAT | Assign issue to Duo Developer service account, `@duo-developer-<ns>` mention, IDE, flows | GitLab runners (own or hosted); .com, Self-Managed, Dedicated | Draft MR linked to issue; AI > Sessions view; Fix-CI and Code Review flows | Group-level controls, AI Catalog | Admin-selected (GPT-5, Claude, Mistral, Llama); self-hosted models; external Claude Code/Codex | GitLab Credits $1 each; $12/$24 per user/mo included (promo) | Fails to build/test without runner config; credit pricing in flux |
| **Replit Agent 4** | APP | Chat in Replit workspace/mobile; parallel agents | Replit cloud (IDE + hosting + DB) | Checkpoints, rollback, preview, app testing | Teams/Enterprise | Vendor-chosen (unverified) | Core ~$20–25; Pro $100; effort-based | Production DB deletion incident (Jul 2025); unpredictable cost |
| **Lovable** | APP | Chat; Agent/Plan modes; scheduled Jobs (secondary) | Lovable cloud + Supabase | Preview, Visual Edits, pre-publish Security Scan | Business plan | Vendor-chosen | Pro $25; Business $50 (annual) | ARR >$600M (reported); RLS CVE-2025-48757 and 2026 exposure reports |
| **Cosmos** (Augment → **Harness**) | PLAT | Linear tickets, PR events, alerts (PagerDuty), Slack feedback, cron, webhooks | Augment-managed isolated environments | "Experts": PR Author fixes CI/comments, Risk Analyzer auto-approves low-risk, Verifier evidence, Incident Investigator | Up to 50 seats on flat plans; Ent. SSO/SCIM/CMEK | Multi-model; LLM at list price + 40% fee | Standard $20 flat; Business $100 flat | Internal: median time-to-merge 11.2h→3.1h; ownership transition |
| **Sweep** | IDE (pivoted) | JetBrains plugin | Local IDE | N/A (issue-to-PR bot deprecated) | — | Own + API models | Pro $20; Ultra $60 (secondary) | Left autonomy: "many years out" |
| **Codegen** (→ **ClickUp**) | PLAT (absorbed) | Formerly GitHub, Slack, Linear; now ClickUp Super Agents | Sandboxed (ClickUp) | — | ClickUp workspace | — | Bundled in ClickUp | Standalone sunset Jan 2026 |
| **Tembo** | PLAT (agent-agnostic) | `@tembo` in GitHub/GitLab/Bitbucket, Linear, Jira, Slack; Sentry/Datadog/PostHog events; schedules; webhooks; API | Tembo VMs (per-second) or **self-hosted VPC** | PRs; switch agent/model per task; Insights | Pro 5 users; Max 10; Ent. SSO/RBAC/audit | **Runs Claude Code, Codex, Cursor, Amp, OpenCode**; BYOK or subscriptions | Pro $60 ($90 usage); Max $200 ($400 usage) | Closest analog to the planned design; small vendor |
| **Blitzy** | ENT | Platform spec/ingest of whole codebase (details unverified) | Blitzy cloud; thousands of agents over days–weeks | Delivers ~80% of a project; humans finish | Enterprise | Multi-vendor (Gemini, GPT, Claude) | ~$1–10M/yr (Forbes via Wikipedia) | SWE-bench Pro 66.5% (paid audit); token-heavy |
| **Warp Oz / Factories** | CA+PLAT | Terminal, GitHub Action/App, triggers | Warp cloud | Factories = pipelines across the dev cycle (beta) | Business tier | Multi-model | PAYG to Enterprise (unverified) | Factories in closed beta / early access (Aug 2026) |
| **Ona** (ex-Gitpod) | PLAT | Linear, Slack, GitHub; Automations | **Customer VPC** environments | Background agents open PRs; kernel-level guardrails ("Veto") | Enterprise | Multi-model (unverified) | Enterprise (unverified) | Vendor claims only |
| **8090 Software Factory** | PLAT/ENT | Governed multiplayer workspace | 8090-hosted | Human-led oversight, audit trail | Enterprise; EY channel | Multi-model (unverified) | $200/user/mo + tokens; Ent. from $1M/yr (secondary) | No independent reviews yet |
| **OpenHands** (OSS + Cloud) | PLAT (OSS) | `@openhands` / label in GitHub, GitLab, Jira, Linear, Slack | Self-host (Docker/K8s) or OpenHands Cloud | Issue resolver → PR | Cloud/Ent. | **Any model** | OSS free; Ent. ~$40/user (unconfirmed) | Self-reported benchmarks |
| **OSS reference factories** (OpenAI Symphony, GitHub gh-aw, Open SWE, Cyrus, Multica, Gas Town, many others) | OSS | Linear/GitHub/Slack polling or webhooks; cron | Self-hosted worktrees/containers | Varies; Symphony updates the issue | — | Agent-agnostic | Free | Mostly previews; prompt-injection risk from issue text |

---

## 3. Per-product notes

### 3.1 Factory (Droids)
- **Vendor / category:** Factory (factory.ai, which now redirects to factory.com). A platform with CLI, IDE, desktop app, web and mobile surfaces. Founded 2023.
- **Intake:** Droid CLI, IDE, Factory desktop app (Mac/Windows), web/mobile at app.factory.ai, Slack, Linear, browser ([Series B post](https://factory.ai/news/series-b)). A June 2026 compilation lists integrations with GitHub, GitLab, Jira, Linear, Sentry, PagerDuty and Slack ([rywalker.com](https://rywalker.com/research/factory-ai), secondary). The docs list **Automations** (triage, code review, QA, documentation, incident response), **Workstreams** (an orchestrator running parallel agents), Missions, headless exec and an API for sessions, computers, wikis and analytics ([docs.factory.com](https://docs.factory.com/)). One 2026 review says team-shared Slack, Linear and Jira delegations ("Remote Delegations") are still in private preview (secondary, unverified).
- **Where it runs:** Locally; on "Droid Computers" (Factory-managed cloud machines, Plus tier and up); on-prem or air-gapped for Enterprise ([pricing](https://factory.com/pricing)).
- **Feedback loop:** CLI sessions sync to the browser. Automations cover code review and incident response. Remote Control lets you steer from another device. The public docs I read do not describe how PR comments or CI results feed back into a session, so that is unverified.
- **Team:** Teams is $60/month per team plus $40 per seat, up to 10 seats. Business adds SSO, SAML/SCIM, audit logs, ZDR and admin controls (model selection, autonomy level, deny lists, network policy). Enterprise adds sub-orgs, data residency, dedicated compute and SLAs ([pricing](https://factory.com/pricing)).
- **Models:** "All leading frontier and open-weight models" (GPT-5, Claude, Gemini). Custom models (BYOK) go in `~/.factory/settings.json` and can point at OpenRouter, Ollama or LM Studio. The docs say only Anthropic and OpenAI official APIs are "fully tested and benchmarked" ([BYOK docs](https://docs.factory.ai/cli/byok/overview)).
- **Pricing (Oct 2026):** Pro $20, Plus $100 (~5× Pro), Max $200 (~10× Pro), Teams $60 + $40/seat, Business and Enterprise custom ([pricing](https://factory.com/pricing)).
- **Performance:** Claimed #1 on Terminal-Bench in Sep 2025 (58.75% with Claude Opus 4.1, self-reported). A later secondary write-up puts Droid with GPT-5.3-Codex at 77.3% on Terminal-Bench 2.0, second behind Forge at 78.4% ([implicator.ai](https://www.implicator.ai/factorys-50m-bet-on-agent-native-coding-meets-a-noisy-market/), unverified). Funding: $50M Series B at a $300M valuation on 25 Sep 2025 (primary). A $150M Series C at $1.5B in Apr 2026 is secondary and unverified. Named customers include MongoDB, EY, Bayer and Zapier.
- **Weaknesses:** Token limits are not disclosed and usage limits roll ("unpredictable costs"). Benchmark and revenue claims lack third-party validation. Community sentiment is mixed ([rywalker.com](https://rywalker.com/research/factory-ai)).

### 3.2 Cognition — Devin (and the Windsurf acquisition)
- **Vendor / category:** Cognition AI. Devin is a cloud agent. Devin Desktop is the IDE formerly called Windsurf, rebranded in June 2026. There is also a CLI.
- **Acquisition:** In July 2025 Cognition signed a definitive agreement to buy Windsurf, after Google's ~$2.4B licensing and acquihire of Windsurf's CEO and senior staff ([Wikipedia](https://en.wikipedia.org/wiki/Cognition_AI)). The price was undisclosed; secondary sources say ~$250M (unverified). Valuation was $10B in Sep 2025 and $26B in May 2026, with talks at ≥$40B reported in Aug 2026 (Bloomberg via Wikipedia).
- **Intake:** Web app; Slack and Microsoft Teams (`@Devin`); Jira; Linear; GitHub (comment `/devin` on any PR); GitLab; Bitbucket; Azure DevOps; Devin API for programmatic sessions with structured results in CI/CD ([integrations docs](https://docs.devin.ai/integrations/overview)).
- **Where it runs:** Cognition-managed VMs. Enterprise offers a dedicated deployment, including in your VPC ([pricing](https://devin.ai/pricing)).
- **Feedback loop:** Session transcripts, PRs, and iteration from PR comments. DeepWiki and AskDevin support planning. Cognition itself says feedback in the middle of a task "works worse than with human juniors," so engineers must scope work up front ([2025 performance review](https://cognition.com/blog/devin-annual-performance-review-2025)).
- **Team:** Teams plan for up to 200 users with shared sessions, an admin dashboard and analytics. Enterprise adds SAML/OIDC SSO, teamspace isolation and multi-org management.
- **Models:** Pro includes frontier models from OpenAI, Anthropic, Google and SpaceXAI, open-source models, and Cognition's own SWE-2 ([pricing](https://devin.ai/pricing)).
- **Pricing:** Restructured on 14 Apr 2026, replacing Core/Team and ACU-first billing (secondary). Current page: Free; Pro $20; Max $200; Teams $80/month plus $40 per dev seat; Enterprise custom. Overage is billed at API pricing.
- **Performance:** Vendor-reported: PR merge rate rose from 34% to 67% year over year, "hundreds of thousands of PRs merged," and ~4× faster problem solving (Nov 2025). Independent: Answer.AI's January 2025 month-long trial got 3 successes, 14 failures and 3 inconclusive results out of 20 tasks ([Answer.AI](https://www.answer.ai/posts/2025-01-08-devin)). That predates the current versions. In the AIDev dataset Devin PRs merged 53.8% of the time, and only 21.6% of the time without a human co-author ([arXiv 2601.15195](https://arxiv.org/html/2601.15195); [arXiv 2606.22711](https://arxiv.org/html/2606.22711v1)).
- **Weaknesses:** Ambiguous end-to-end projects, visual design without specs, and requirement changes mid-task (Cognition's own list). Pricing has changed repeatedly.

### 3.3 OpenAI Codex (cloud agent + Slack/GitHub/Linear)
- **Vendor / category:** OpenAI. A cloud agent plus an open-source CLI, IDE extension and desktop app. Secondary sources say the desktop app merged into ChatGPT desktop on 9 Jul 2026 (unverified).
- **Intake:** Web, mobile, desktop and CLI ([cloud docs](https://learn.chatgpt.com/docs/cloud)). **Slack** (`@Codex`), which went GA with the SDK on 6 Oct 2025 ([InfoWorld](https://www.infoworld.com/article/4070541/openai-codex-adds-sdk-admin-tools-slack-integration.html)). **Linear** since 4 Dec 2025: assign an issue, mention `@Codex`, or set triage rules that auto-delegate new issues. Triage-rule runs execute under the issue creator's account ([Linear docs](https://learn.chatgpt.com/docs/third-party/linear); [Linear changelog](https://linear.app/changelog/2025-12-04-openai-codex-agent)). **GitHub** code review by tagging `@Codex` or turning on automatic reviews. `openai/codex-action` for CI. Agent HQ inside GitHub.
- **Where it runs:** One OpenAI-managed workspace per task. An "environment" holds repos, an install script, network policy (none, package managers only, or an allowlist), secrets and OIDC connections. Environments can be shared with a team.
- **Feedback loop:** Inspect the diff and results, send follow-ups, then commit or open a PR. Linear progress appears in the issue's Activity with a link to the chat. GitHub reviews post as PR feedback.
- **Team:** Shareable environments. Business adds larger cloud VMs, SSO and MFA. Enterprise adds SCIM, EKM, the Compliance API and residency controls.
- **Models:** OpenAI only (GPT-6.1 Sol/Terra and GPT-6 Luna/Astra appear on the Oct 2026 pricing page). Cloud features are **not** available with an API key ([pricing](https://learn.chatgpt.com/docs/pricing)).
- **Pricing:** Plus $20; Pro $100, $200 or $500; Business $20/user/month annual ($25 monthly); Enterprise custom. Credits extend limits. Cloud tasks share the plan allowance and "may use more" of it.
- **Performance/adoption:** OpenAI said Codex passed 5M weekly active users on 2 Jun 2026 ([Constellation](https://www.constellationr.com/insights/news/openai-touts-broadening-codex-usage-5-million-weekly-active-users)). In the AIDev dataset Codex PRs had the highest merge rate (82.6%, n=21,799). That likely reflects a human picking which cloud-task results become PRs (my interpretation, not a study finding).
- **Weaknesses:** Slack-triggered tasks require GitHub. GitLab and Bitbucket are not supported for them ([secondary guide](https://codex.danielvaughan.com/2026/04/08/codex-cloud-task-application/)). Usage limits are published only as estimates. Cloud is locked to OpenAI models.

### 3.4 Anthropic Claude Code (CLI, cloud/web, GitHub Action, Agent SDK, Slack)
- **Vendor / category:** Anthropic. CLI, IDE extensions and desktop app, plus a cloud agent ("Claude Code on the web" / cloud sessions), Code Review, cloud scheduled tasks (formerly "routines"), Projects (one conversation coordinating many cloud sessions), the GitHub Action, GitLab CI/CD and the Agent SDK ([platforms doc](https://code.claude.com/docs/en/platforms)).
- **Intake:** CLI; `claude --cloud "<task>"`; web, mobile and desktop; Dispatch from phone to desktop; Remote Control; **Channels**, which push events from Telegram, Discord or your own server into a local session. **Slack:** `@Claude` in channels routes coding intent to a cloud session for Pro, Max and Ultra users ([Slack doc](https://code.claude.com/docs/en/slack)). Team and Enterprise workspaces move to **Claude Tag**, a shared, admin-scoped org identity. The legacy bot stopped answering in Tag-connected workspaces on 5 Oct 2026. **GitHub Action** (`anthropics/claude-code-action@v1`): `@claude` mentions, newly opened issues, any GitHub event, or `schedule` cron ([GitHub Actions doc](https://code.claude.com/docs/en/github-actions)). **Cloud scheduled tasks** trigger on a schedule, an API call or GitHub events. Linear and Jira connect through MCP.
- **Where it runs:** Local machine. Anthropic-managed isolated VMs, where git credentials stay outside the VM behind a GitHub proxy and egress is limited by default. **Self-hosted environments** (runners on your own infrastructure, Team and Enterprise). GitHub or GitLab runners for CI ([cloud doc](https://code.claude.com/docs/en/claude-code-on-the-web.md)).
- **Feedback loop:** In Slack, Claude posts progress in the thread and then @-mentions you with View Session, Create PR or Change Repo buttons. The cloud diff view supports inline comments that go back to Claude. **Auto-fix PRs:** Claude subscribes to the PR's GitHub events and pushes fixes for CI failures and review comments. It asks first when a comment is ambiguous, and labels its GitHub replies as Claude Code. Limits: GitHub sends no webhook when the base branch moves and creates a merge conflict, so auto-fix cannot react to conflicts by itself; and its replies can trigger comment-driven automation such as Atlantis. `--teleport` pulls a cloud session into the terminal, and `claude -p --cloud <id>` queues follow-ups from scripts or CI.
- **Team:** Sessions visible to the team (Slack sessions are auto-shared), org-shared environments, custom roles, admin policies (`allow_remote_sessions`), analytics. Claude Tag gives admin-configured channel access.
- **Models:** Claude only. Providers: Anthropic API, Amazon Bedrock, Google Cloud's Agent Platform (Vertex) and Microsoft Foundry. LLM gateways work through `ANTHROPIC_BASE_URL`, but Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" ([gateway doc](https://code.claude.com/docs/en/llm-gateway.md)). Cloud sessions, `--cloud` and teleport need a claude.ai login and are unavailable with third-party providers.
- **Pricing (Oct 2026):** Pro $20/month ($17 annual); Max $100 (5× Pro); Ultra $200 (no 5-hour limit, 10× weekly); Team standard seat $25 ($20 annual), premium seat $125 ($100 annual); Enterprise $20/seat plus usage at API rates, 20-seat minimum ([claude.com/pricing](https://claude.com/pricing)). Cloud VMs carry no separate charge but count toward plan limits. GitHub Action runs cost Actions minutes plus API tokens, or subscription usage if run with an OAuth token.
- **Performance/adoption:** Anthropic reported a Claude Code run-rate above $2.5B in Feb 2026, via secondary coverage ([VentureBeat context](https://venturebeat.com/technology/anthropic-says-it-hit-a-30-billion-revenue-run-rate-after-crazy-80x-growth)). Later figures such as ~$8B are unverified. AIDev merge rate was 59.0%, on a small sample (n=459, Dec 2024–Jul 2025).
- **Weaknesses:** Recurring complaints about usage limits. *The Register* reported a backlash on 5 Jan 2026 ([The Register](https://www.theregister.com/2026/01/05/claude_devs_usage_limits/)). Anthropic acknowledged a weekly-limit bug affecting ~3% of Max and Pro users on 19 Jun 2026, and an Apr 2026 postmortem reportedly covered a regression (both secondary). Cloud, Slack and auto-fix require GitHub (GHES is supported on Team and Enterprise). Orgs with ZDR, HIPAA or CMEK cannot use cloud sessions, and an org IP allowlist breaks Anthropic-hosted sessions. Subscription OAuth may not be used to power third-party products (see §6).

### 3.5 GitHub Copilot cloud agent (formerly "coding agent")
- **Vendor / category:** GitHub (Microsoft). A cloud agent built into GitHub. It went GA on 25 Sep 2025 ([changelog](https://github.blog/changelog/2025-09-25-copilot-coding-agent-is-now-generally-available/)) and was renamed "Copilot cloud agent" in Mar 2026.
- **Intake:** Assign an issue to Copilot; the Agents tab; the Copilot panel; VS Code; Copilot CLI; the Copilot app; Mobile; Slack; Teams; Linear; Azure Boards; Raycast ([agents page](https://github.com/features/copilot/agents)). **Jira:** public preview 5 Mar 2026, GA 25 Jun 2026 with progress streamed into the Jira issue and follow-ups from the Jira panel. Requires Jira Cloud with Rovo ([GA changelog](https://github.blog/changelog/2026-06-25-github-copilot-for-jira-is-now-generally-available/)). Also code-scanning alerts, and Automations or **GitHub Agentic Workflows** for schedules and repo events.
- **Where it runs:** A GitHub Actions runner (one repo, 59-minute cap, custom or self-hosted runners supported, logs kept 28 days) or the newer cloud sandbox (sessions can span repos in one org) ([docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)).
- **Feedback loop:** Draft PR plus session logs. `@Copilot`, `@Claude` or `@Codex` mentions in PR comments start follow-up work ([Agent HQ](https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/)). Copilot code review. **Agent Merge** watches a PR and works on failed Actions workflows and merge conflicts. Branch rulesets can block the agent unless an admin grants a bypass.
- **Team:** Org policies, shared sessions, admin spend limits.
- **Models:** Picker or "Auto." BYOK and local models on some surfaces. Agent HQ runs Claude and Codex agents (public preview; first Pro+ and Enterprise, later "paid plans," secondary).
- **Pricing:** Free; Pro $10 ($15 of credits); Pro+ $39 ($70); Max $100 ($200); Business $19/user; Enterprise $39/user. 1 credit = $0.01 ([features page](https://github.com/features/copilot/agents); [DevTools Review](https://devtoolsreview.com/pricing/copilot-pricing/), secondary). AI Credits replaced premium requests on 1 Jun 2026 (secondary). Agent tasks also consume Actions minutes.
- **Performance:** Copilot PRs had the lowest merge rate in AIDev (43.0%). Fully autonomous Copilot PRs merged only 6.2% of the time, against 47.4% when co-authored. 54.5% of the autonomous ones were single-commit `[WIP]` drafts ([arXiv 2606.22711](https://arxiv.org/html/2606.22711v1)).
- **Weaknesses:** GitHub-hosted repos only. Pricing changes and consumption complaints ([community discussion](https://github.com/orgs/community/discussions/163868)). Short runtime cap on Actions sessions.

### 3.6 Cursor background/cloud agents (Anysphere, now SpaceX)
- **Vendor / category:** Anysphere (Cursor). An IDE plus cloud agents, CLI, Bugbot (PR review), **Automations** (5 Mar 2026) and Projects (beta, Sep 2026). SpaceX agreed to acquire Cursor in Apr 2026, exercised the option in Jun 2026, and closed on **14 Aug 2026**. Cursor is now integrated into SpaceXAI ([Wikipedia](https://en.wikipedia.org/wiki/Cursor_(company))).
- **Intake:** Desktop; Web (cursor.com/agents); iOS; Android PWA; Slack `@cursor`; GitHub or Bitbucket comment `@cursor`; Linear `@cursor`; API ([cloud agent docs](https://cursor.com/docs/cloud-agent)). Automations trigger on a schedule or on events from Slack, Linear, GitHub, GitLab, Bitbucket, Sentry, PagerDuty and webhooks ([changelog](https://cursor.com/changelog/03-05-26)). Slack triggers see public channels only. "Subscriptions" (19 Aug 2026, secondary) let a running agent wake on activity.
- **Where it runs:** Cursor-managed isolated VMs. "Self-Hosted Machines" can run tool execution on your own hardware.
- **Feedback loop:** A dashboard shows environment, build and version history. Agents deliver "merge-ready PRs" with screenshots, videos and logs. You can take over the agent's remote desktop. Admins can allow team follow-ups. Bugbot Autofix spawns cloud agents. Secrets are injected only when an agent starts.
- **Team:** Teams $30+/user with pooled usage, SSO and analytics. Enterprise adds SCIM, audit logs, service accounts, and repo/model/MCP access controls ([pricing](https://cursor.com/pricing)).
- **Models:** Since the "X Subscription" bundle launched on 12 Oct 2026, Plus ($8) is Grok-only with no cloud agents. Premium and above add third-party models billed at API list price ([Teslarati](https://www.teslarati.com/spacex-just-combined-grok-cursor-and-x-into-one-mega-plan/); [pricing](https://cursor.com/pricing)). Composer 2 (Mar 2026) was built on Moonshot's Kimi 2.5, which was not disclosed at launch.
- **Pricing:** Free / Plus $8 / Premium $30 / Super $100 / Ultra $200. Bugbot moved from $40/seat to usage-based billing (~$1–1.50 per run; [May 2026 post](https://cursor.com/blog/may-2026-bugbot-changes)) and is now included from Premium.
- **Performance:** ARR about $3B by May 2026 (Bloomberg via Wikipedia). AIDev merge rate 65.2%.
- **Weaknesses:** Repeated pricing upheaval (the Jul 2025 usage-metering backlash and refunds; the 2026 Grok bundle). The Kimi disclosure controversy. Strategic risk from the change of control.

### 3.7 Google Jules
- **Vendor / category:** Google. An asynchronous cloud agent.
- **Intake:** jules.google web UI; a `jules` label on a GitHub issue; Jules Tools CLI; v1alpha REST API ([jules.google](https://jules.google/); [Morph](https://www.morphllm.com/comparisons/jules-google-coding-agent), secondary). Linear support is MCP-only: the agent can read and update tickets, but you cannot assign work from Linear ([sinatra.dev](https://www.sinatra.dev/blog/google-jules-review), secondary).
- **Where it runs:** Clones the repo into a Google Cloud VM.
- **Feedback loop:** Proposes a plan for approval, then shows a diff and opens a PR.
- **Team:** Limited. One source says Workspace and enterprise accounts could not buy paid Jules tiers as of mid-2026 (unverified).
- **Models:** Gemini only. Gemini 2.5 Pro on the free tier, Gemini 3 Pro on Pro and Ultra.
- **Pricing:** Free: 15 tasks/day, 3 concurrent. Pro: 100/day, 15 concurrent. Ultra: 300/day, 60 concurrent. Bundled with Google AI Pro (~$19.99) and Ultra; sources disagree on the Ultra price.
- **Weaknesses:** GitHub-only. Gemini-only with no BYOK. Struggles with vague or multi-step architectural tasks. Called slow in reviews (secondary).

### 3.8 Amazon Kiro / Q Developer
- **Vendor / category:** AWS. The Kiro IDE (built on Code OSS) and Kiro CLI went GA on 17 Nov 2025. The **Kiro autonomous agent** was announced as a "frontier agent" preview at re:Invent (Dec 2025), alongside the AWS Security Agent and AWS DevOps Agent ([About Amazon](https://www.aboutamazon.com/news/aws/amazon-ai-frontier-agents-autonomous-kiro)). **Kiro Web** entered public preview around early May 2026 and replaced the waitlist preview ([AWS Builder hands-on](https://builder.aws.com/content/3DZ4AIZNUZCq8SWDUlGc7Ort7qx/hands-on-with-kiro-web-preview-inside-kiro-web-preview-two-real-builds-powers-mcp-and-kiro-fix-on-github-issues)). Kiro Crew is an open-source workspace that drives Kiro CLI sessions behind approval gates.
- **Intake:** Kiro Web chat in collaborative or autonomous mode. `/kiro fix` on a GitHub issue or PR review. Jira assignment (read ticket → draft spec → wait for human approval) and Slack were announced for the autonomous agent ([dev.to](https://dev.to/aws-builders/aws-catching-up-on-the-basic-functions-of-kiro-autonomous-agent-preview-frontieragents-5e85), secondary). Agent hooks.
- **Where it runs:** A remote sandbox in us-east-1 during preview. Network defaults to "repository access only."
- **Feedback loop:** An activity feed narrates the steps. `kiro-agent[bot]` reacts on the issue and replies with a "View session" link. `/kiro fix` reads review comments and pushes a commit to the same branch. In autonomous mode the agent also answers review feedback. AWS says the agent "learns from pull requests and feedback."
- **Team:** Enterprise through AWS with IAM Identity Center; an admin must enable an "Autonomous agents" toggle.
- **Models:** "Auto" (a mix of frontier and specialized models) plus Claude (Opus 5, Sonnet 5 and others), GPT-5.6 and open-weight models (DeepSeek 3.2, MiniMax M2.5, GLM-5, Qwen3 Coder Next), with credit multipliers ([pricing](https://kiro.dev/pricing/)).
- **Pricing:** Free (50 credits), Pro $20 (1,000), Pro+ $40 (2,000), Pro Max $100 (5,000), Power $200 (10,000). Overage $0.04/credit. GovCloud costs ~20% more.
- **Q Developer:** AWS ends support for the Q Developer IDE plugins on **30 Apr 2027** and points users to Kiro ([AWS docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-developer-ide-end-of-support.html)). Secondary sources report new sign-ups blocked from 15 May 2026 and the Q Developer GitHub App ending 30 Jan 2027 (unverified).
- **Weaknesses:** Preview status, us-east-1 only, roughly one PR per session with no multi-PR campaigns, and MCP servers running outside the sandbox with access to secrets ([AWS Builder](https://builder.aws.com/content/3DZ4AIZNUZCq8SWDUlGc7Ort7qx/hands-on-with-kiro-web-preview-inside-kiro-web-preview-two-real-builds-powers-mcp-and-kiro-fix-on-github-issues)).

### 3.9 Atlassian Rovo Dev
- **Vendor / category:** Atlassian. CLI, VS Code and code review. GA around Oct 2025 (secondary, unverified).
- **Intake:** Jira work items become a code plan and then code. CLI. Bitbucket Pipelines. Code review in Bitbucket Cloud and GitHub, checking changes against Jira acceptance criteria ([product page](https://www.atlassian.com/software/rovo-dev)).
- **Where it runs:** Locally or in CI. No hosted cloud runtime is described.
- **Status:** Atlassian's page now says **"Rovo Dev is reaching end of life as a standalone product."** Its capabilities move into Jira and Teamwork Collection. No EOL date is set (at least 60 days' notice). Code Reviewer moves to Rovo credits on 3 Dec 2026. The CLI becomes a unified "Rovo CLI" ([dev.to analysis](https://dev.to/mihai_leanzero/rovo-dev-pricing-after-end-of-life-standard-cli-credits-4p9c); [Atlassian FAQ](https://www.atlassian.com/licensing/rovo-dev)).
- **Pricing:** Standard $20/dev/month with 2,000 credits, then $0.01/credit. A free tier gives 350 credits. No exchange rate between Rovo Dev credits and Rovo credits has been published.
- **Related:** Jira now lets you assign any work item to **Claude, Cursor, Codex, GitHub Copilot** or a native Jira Coding Agent, and create items from Slack with `@Jira` ([Jira for AI-native dev](https://www.atlassian.com/software/jira/dev)). The tracker is becoming the vendor-neutral control plane.
- **Performance:** Testimonial claim of a 45% cut in PR cycle time at Atlassian (vendor).

### 3.10 GitLab Duo Agent Platform
- **Vendor / category:** GitLab. An agent platform inside GitLab, GA on **15 Jan 2026** ([GitLab blog](https://about.gitlab.com/blog/gitlab-duo-agent-platform-is-generally-available/)).
- **Flows and agents:** Developer flow (issue → draft MR), Convert to GitLab CI/CD, Fix CI/CD pipeline, Code Review, and software development in the IDE. Planner and Security Analyst agents. Custom agents and flows from the AI Catalog. **External agents: Claude Code and Codex CLI.** An MCP client connects to Jira, Confluence, Slack, Grafana and others.
- **Intake:** Assign the issue to the *Duo Developer* service account, or mention `@duo-developer-<namespace>` (mention triggers arrived in 18.11) ([docs](https://docs.gitlab.com/user/duo_agent_platform/flows/foundational_flows/developer.html)).
- **Where it runs:** CI runners (yours or GitLab-hosted). Available on GitLab.com, Self-Managed and Dedicated. Self-hosted models are supported on Self-Managed.
- **Feedback loop:** Progress under AI > Sessions. A draft MR linked to the issue, authored by a service account. A Fix-CI flow.
- **Models:** Admin-selected: OpenAI GPT-5 variants, Anthropic Claude, Mistral, Meta Llama, plus self-hosted.
- **Pricing:** GitLab Credits ($1 each). Premium and Ultimate include $12 and $24 per user per month, as a promotion "subject to change." Overage is billed on demand. Service accounts get no included credits ([credits docs](https://docs.gitlab.com/subscriptions/gitlab_credits)).
- **Weaknesses:** The docs warn that without a runner configuration the flow "cannot install dependencies or run tests" and is more likely to produce changes that don't build. Pricing is still settling.

### 3.11 Replit Agent
- **Vendor / category:** Replit. An app-builder platform covering IDE, hosting and database. Agent 4 launched on 11 Mar 2026 alongside a $400M Series D at a $9B valuation ([dealroom](https://dealroom.co/news/126729-replit-confirms-400m-series-d-at-9b-valuation-launches-agent-4-to-let-an/), secondary).
- **Intake / runtime / feedback:** Chat inside the Replit workspace, including mobile. Parallel agents. Runs on Replit's cloud, with checkpoints, rollback, live preview and app testing.
- **Models:** Chosen by Replit; specifics unverified.
- **Pricing:** Core ~$20–25 and Pro ~$100 (sources conflict). **Effort-based** agent pricing, with confirmation before paid work ([billing docs](https://docs.replit.com/billing/ai-billing)).
- **Performance/adoption:** ~$525M annualized revenue in Apr 2026 (a Sacra estimate, unverified).
- **Weaknesses:** In Jul 2025, during a user-declared code freeze in Jason Lemkin's (SaaStr) trial, the agent deleted a production database. Replit's CEO called it "unacceptable" and promised automatic dev/prod database separation ([TechTarget](https://www.techtarget.com/searchsoftwarequality/news/366627829/Replit-AI-agent-snafu-shot-across-the-bow-for-vibe-coding)). Costs remain hard to predict.

### 3.12 Lovable
- **Vendor / category:** Lovable (Sweden). An AI app builder: prompt to full-stack React app with a Supabase backend and GitHub sync.
- **Intake / runtime / feedback:** Chat with Agent Mode and Plan Mode. Visual Edits. A pre-publish Security Scan. Subagents and scheduled "Jobs" reportedly arrived May–Jun 2026 (secondary). Runs on Lovable's cloud.
- **Pricing:** Pro $25 and Business $50 per month (annual). Credits; reviewers say debugging loops burn them quickly.
- **Adoption:** $330M at $6.6B (Dec 2025). $400M Series C at **$13.3B** (Aug 2026, Menlo-led). ARR reported above $600M as of 24 Sep 2026 ([dealroom](https://dealroom.co/news/144597-lovable-raises-400m-at-13-3b-valuation-eyes-600m-revenue-run-rate/), secondary).
- **Weaknesses:** **CVE-2025-48757.** A scan of 1,645 showcase apps found 170 (~10%) with insufficient Supabase RLS, exposing 303 endpoints; disclosed 29 May 2025 ([Superblocks](https://superblocks.com/blog/lovable-vulnerabilities)). Further disclosures in Feb and Apr 2026 alleged exposure of other users' project code and chat histories ([bastion.tech](https://bastion.tech/blog/lovable-april-2026-data-breach), secondary, partly unverified).

### 3.13 Augment Code → Cosmos (now Harness)
- **Vendor / category:** Augment Code. Its **Cosmos** cloud-agent platform is explicitly marketed as a "Software Factory." On **8 Oct 2026** Harness announced it had acquired "select Augment Code assets, including Cosmos, the Auggie CLI, the Code Context Engine," and the team. Cosmos becomes the "Harness Cosmos Software Factory Agent." It is still available at cosmos.augmentcode.com. Terms were not disclosed ([Harness blog](https://www.harness.io/blog/harness-acquires-augment-code-cosmos)). What remains of Augment Code is unverified.
- **Intake:** Requirements to tickets (Linear), tickets assigned to Cosmos, PR opened or updated, product feedback in Slack, PagerDuty alerts, cron and webhooks ([Augment blog](https://www.augmentcode.com/blog/beyond-ai-coding-agents-how-we-built-augments-software-factory); [docs](https://docs.augmentcode.com/cosmos/software-factory/overview)).
- **Feedback loop:** This is the most fully described loop in the market. "Experts" divide the work: Project Builder, PR Author / Ticket Manager (fixes CI, conflicts and review comments), Risk Analyzer (auto-approves low-risk PRs), Deep Reviewer, Pair Reviewer, Verifier (runtime evidence from E2E tests), Feedback Triager and Incident Investigator. Humans approve designs, review evidence and make the final merge.
- **Pricing:** Standard $20 flat (includes $20 of usage, up to 50 seats); Business $100 flat; Enterprise custom. LLM usage is billed at the provider's list price plus a 40% service fee ([pricing](https://www.augmentcode.com/pricing)).
- **Performance (internal case study, 17,200 merged PRs, Nov 2025–Jul 2026):** PRs per active developer up 2.7×. Median time-to-merge down from 11.2h to 3.1h. 14-day revert rate down from 1.9% to 0.4%. Human touchpoints per PR down from 10–15 to about 3. This is longitudinal and not controlled, a point Augment makes itself.
- **Weaknesses:** Ownership transition risk. The production-feedback learning loop has not shipped yet ([The New Stack](https://thenewstack.io/harness-augment-cosmos-acquisition/) headline; Harness lists it as planned).

### 3.14 Sweep
- Began in 2023 as an open-source YC (S23) GitHub-issue-to-PR bot. In 2025 it pivoted to a **JetBrains plugin** (next-edit autocomplete plus an in-IDE agent) after the founders concluded full autonomy was "many years out." The original bot is deprecated or unmaintained ([JetBrains forum](https://platform.jetbrains.com/t/sweep-ai-coding-assistant-purpose-built-for-jetbrains/1317); [aiwiki](https://aiwiki.ai/wiki/sweep_ai), secondary). Pricing per secondary sources: Pro $20, Ultra $60. A co-founder reportedly left for xAI in Mar 2026 (unverified). **Lesson:** the earliest issue-to-PR startup left the category.

### 3.15 Codegen
- Codegen offered agents across GitHub, Slack and Linear. ClickUp acquired it on **23 Dec 2025** (terms undisclosed) to power ClickUp "Super Agents." CEO Jay Hack became ClickUp's Head of AI. The standalone service sunset in Jan 2026 ([ClickUp](https://clickup.com/blog/clickup-codegen-acquisition/); [Orrick](https://www.orrick.com/en/News/2025/12/Codegen-Acquired-by-ClickUp)). **Lesson:** work-management vendors want the coding agent inside the tracker.

### 3.16 Tembo
- **Vendor / category:** Tembo. An **agent-agnostic orchestration platform**. It sells no agent of its own; it runs Claude Code, Codex, Cursor, Amp or OpenCode, switchable per task ([pricing](https://www.tembo.io/pricing)).
- **Intake:** `@tembo` in GitHub, GitLab, Bitbucket, Linear, Jira and Slack. Sentry, Datadog and PostHog events. Schedules, webhooks, the API and custom MCP.
- **Where it runs:** Tembo cloud VMs, billed per second ($0.1066–$2.9536/hour by size, nothing while stopped), or **self-hosted in your VPC**.
- **Models:** Tembo Gateway (for example claude-opus-4-8 at $5.75/$28.75 per million input/output tokens), BYOK, or a connected Claude, ChatGPT/Codex or SuperGrok subscription. Note: connecting a Claude subscription to a third-party product sits awkwardly with Anthropic's stated policy (see §6); I have not verified whether Tembo has approval.
- **Pricing:** Pro $60/month ($90 of usage, up to 5 users); Max $200 ($400 of usage, up to 10 users); Enterprise custom (SSO, RBAC, audit, VPC peering).
- **Relevance:** This is the closest commercial analog to a self-hosted factory driving Claude Code behind an adapter. Its evidence is mostly its own marketing.

### 3.17 Blitzy
- **Vendor / category:** Blitzy (Cambridge, MA; founded 2023). An enterprise batch "autonomous development" platform. It ingests codebases of 1M to 100M+ LOC into a knowledge graph. "Blitzy OS" coordinates **thousands of agents over days to weeks.** It claims to complete ~80% of a project, with humans finishing the rest ([Wikipedia](https://en.wikipedia.org/wiki/Blitzy)).
- **Models:** Third-party (Gemini, GPT, Claude); no in-house foundation model.
- **Pricing:** $1M–$10M per year, about $0.20 per line of code (Forbes via Wikipedia). The site also lists a $0 "Private Sandbox" tier, which conflicts.
- **Performance:** SWE-bench Pro Public 66.5% and SWE-bench Verified 86.8%, audited by **Quesma under contract to Blitzy** ([Quesma](https://quesma.com/blog/verifying-blitzy-swe-bench-pro/)). Quesma's audit compared against GPT-5.4 on only 9 tasks.
- **Funding:** $200M at $1.4B, May 2026, led by Northzone ([SiliconANGLE](https://siliconangle.com/2026/05/05/blitzy-raises-200m-1-4b-valuation-deploy-thousands-coding-agents-parallel/)).
- **Weaknesses:** Token-heavy and opinionated. Onboarding takes "hours or days." Opaque enterprise pricing.

### 3.18 Newer entrants and adjacent players (2025–2026)
- **Warp:** Launched the **Oz** cloud-agent platform on 10 Feb 2026 and **Warp Factories** (cloud agent pipelines across the dev cycle) in closed beta or early access around 18–27 Aug 2026. Pricing reportedly runs from pay-as-you-go at about API +20% up to Enterprise, with $10k of factory credit for beta orgs (secondary, unverified) ([usagepricing](https://www.usagepricing.com/blueprint/activity/warp-2026-08-packaging)). Ships `oz-agent-action` and `oz-for-oss`.
- **Ona** (Gitpod renamed itself in Sep 2025): background agents plus Automations running **inside the customer's VPC**, kernel-level guardrails ("Veto"), and intake from Linear, Slack and GitHub ([The Register](https://www.theregister.com/2025/09/03/gitpod_rebrands_as_ona/)). Built its own factory "in 10 days" (Apr 2026, per Ostrovsky).
- **8090 Software Factory** (Chamath Palihapitiya, CEO): a "governed multiplayer platform" for regulated enterprises. $135M Series A led by Salesforce Ventures (30 Jun 2026). Self-serve reportedly $200/user/month plus tokens; Enterprise from $1M/year. Distributed through EY.ai PDLC ([TNW](https://thenextweb.com/news/chamath-palihapitiya-8090-135m-series-a-ai-coding); pricing secondary).
- **OpenHands** (MIT): the most-used self-hosted autonomous agent (70k+ GitHub stars, self-reported). Cloud and self-hosted K8s with Slack, Jira and Linear integrations triggered by `@openhands` or a label ([docs](https://docs.all-hands.dev/usage/cloud/project-management/overview)). Its "Agent Canvas" control center can run Claude Code, Codex or Gemini through the Agent Client Protocol ([OpenHands blog](https://www.openhands.dev/blog/open-source-ai-coding-agents), vendor).
- **Buildful** (formerly FactoryKit, from the Hashnode team): ticket to tested PR with recorded browser QA; $10/month for 1,000 tasks, $40 for teams (vendor; [Hashnode](https://hashnode.com/blog/ai-software-factory)).
- **Port, Overcut, Harness (Autonomous SDLC):** governance and control-plane plays around coding agents (secondary roundups).
- **Open-source reference factories** (curated in [awesome-software-factories](https://github.com/varun1505/awesome-software-factories)):
  - **OpenAI Symphony:** a spec plus an Elixir reference that polls Linear, creates isolated workspaces, dispatches agents and updates the issue. It is an "engineering preview" with a known prompt-injection risk from issue text ([Better Stack](https://betterstack.com/community/guides/ai/openai-symphony/)).
  - **GitHub Agentic Workflows (gh-aw):** Markdown plus YAML compiled to Actions.
  - **LangChain Open SWE:** Slack, Linear and GitHub intake.
  - **Cyrus:** Linear issues worked by Claude Code in worktrees.
  - **Multica, Gas Town (Steve Yegge), StrongDM Attractor** (unmaintained), and dozens of Ralph-loop variants.
- **In-house factories at large companies** (from Ostrovsky's Sep 2026 survey):
  - StrongDM (Feb 2026).
  - WorkOS "Project Horizon."
  - LaunchDarkly: guarded releases behind feature flags.
  - Cloudflare "Astro": bug triage on Actions; open issues fell from 200+ to about 30.
  - Vercel ai-sdk-factory: 25–35% of merged PRs after 4 weeks, and over 75% of the issues closed in July. Humans merge.
  - Uber: a company-wide managed-agent platform.

---

## 4. Independent performance evidence

### 4.1 Benchmarks: saturated, contaminated, harness-dependent
- **SWE-bench Verified is effectively retired.** OpenAI stopped reporting it on 23 Feb 2026. It cited saturation and contamination, plus an audit finding that ≥59.4% of an audited subset of commonly failed tasks had flawed tests that reject correct fixes, and it now recommends SWE-bench Pro ([OpenAI Devs on X](https://x.com/OpenAIDevs/status/2026002219909427270); [codesota](https://www.codesota.com/news/swe-bench-contamination-debate), secondary). Aggregators show top scores of about 95–97% (Claude Opus 5 ~96%, Claude Fable 5 95.0%, Oct 2026) ([BenchLM](https://benchlm.ai/benchmarks/swe-bench-verified); [LLM Stats](https://llm-stats.com/benchmarks/swe-bench-verified)). BenchLM no longer ranks on Verified.
- **SWE-bench Pro** (Scale AI; 1,865 tasks split into public, commercial (276 private startup repos) and held-out) ([arXiv 2509.16941](https://arxiv.org/pdf/2509.16941)). Best *public* scores are around 57.7–59.1% (GPT-5.4 at xhigh effort, GPT-5.5), and the private commercial subset tops out around 47–52%. Both ranges come from conflicting aggregators and are unverified ([Scale leaderboard](https://labs.scale.com/leaderboard/swe_bench_pro_public_v2); [Morph](https://www.morphllm.com/swe-bench-pro)). Public SWE-bench Pro scores are self-reported, and the board does not accept closed-source agents ([Quesma](https://quesma.com/blog/verifying-blitzy-swe-bench-pro/)).
- **Harness matters as much as the model.** Blitzy (66.5%) beat raw GPT-5.4 (57.7%) on SWE-bench Pro Public. Quesma attributes the gap to the last step: actually running the tests rather than declaring the code "should work." GPT-5.3-Codex scores higher on Terminal-Bench 2.0 in the Codex harness than in Terminus-2. HN users report the "same model, opus, works better in 3P harnesses such as Factory Droid or Amp" (anecdotal, via [rywalker.com](https://rywalker.com/research/factory-ai)). **No public benchmark measures ticket-to-merged-PR reliability**, and no vendor publishes a first-attempt merge rate ([Hashnode](https://hashnode.com/blog/ai-software-factory)).

### 4.2 METR randomized studies
- **Jul 2025 RCT:** 16 experienced open-source developers, 246 tasks on their own repos, early-2025 tools (Cursor with Claude 3.5/3.7). Developers were **19% slower** with AI, even though they expected a 24% speed-up and afterwards believed they had been ~20% faster ([METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)).
- **24 Feb 2026 update:** "We are Changing our Developer Productivity Experiment Design" ([METR](https://metr.org/blog/2026-02-24-uplift-update/)). The late-2025 follow-up had 57 developers, 143 repos and 800+ tasks. Returning developers showed about 18% less time per task (CI: 38% *less* time to 9% *more*), and new recruits about 4% less (CI: 15% less to 9% more). METR calls this an "unreliable signal," mainly because of selection effects: developers refused to work without AI, and pay was cut from $150 to $50 an hour. METR believes developers are probably sped up more now than in early 2025 and is moving to developer-level randomization ([Rob Bowley summary](https://blog.robbowley.net/2026/04/04/metrs-developer-productivity-research-2026-update/); [dev.to](https://dev.to/gabrielanhaia/metrs-ai-coding-speed-study-broke-too-many-developers-wouldnt-work-without-ai-5afm)). Posts claiming METR "found an 18% boost" misread it.

### 4.3 DORA 2025 (Google Cloud), published 23 Sep 2025
- About 5,000 respondents. **90%** use AI (+14 points year over year). Median AI use is 2 hours a day. Over 80% perceive a productivity gain and 59% a positive effect on code quality. **30%** have little or no trust in AI-generated code, and only 24% trust it "a lot" or "a great deal" ([Google blog](https://blog.google/technology/developers/dora-report-2025/)).
- AI adoption is now linked to **higher throughput** (reversing 2024), but "software delivery instability continues to rise" ([InfoQ](https://www.infoq.com/news/2025/09/dora-state-of-ai-in-dev-2025)). AI acts as an "amplifier": gains concentrate in teams with loosely coupled architecture, fast feedback loops and solid platforms. The report introduces a seven-capability DORA AI Capabilities Model and seven team archetypes.

### 4.4 Telemetry and pipeline studies
- **Faros AI (2025):** 10,000+ developers across 1,255 teams. High-AI-adoption teams completed **21% more tasks** and merged **98% more PRs**, but **review time rose 91%**, PRs got 154% larger and bugs per developer rose 9%. There was **no significant company-level improvement** ([summaries](https://getunblocked.com/blog/ai-productivity-paradox/); [Faros research](https://faros.ai/research)). Faros sells analytics. Its 2026 follow-up covers 22,000 developers; details unverified.
- **CircleCI State of Software Delivery 2026** (28M workflows; sponsored by Thoughtworks): for the median team, feature-branch throughput rose 15% while **main-branch throughput fell 7%** (Feb 2026). In the Q3 2026 Pulse, main-branch success improved from 70.8% (Q1) to 78.3%, still below CircleCI's 90% benchmark. Median main-branch throughput is flat at 1.7 runs a day, while the top 5% run 10.4× the median ([CircleCI Q3](https://circleci.com/blog/five-takeaways-2026-q3-pulse/); critique by [Rob Bowley](https://blog.robbowley.net/2026/04/02/more-code-less-delivery-but-does-the-circleci-2026-report-really-show-1-in-20-teams-are-benefiting/)).
- **GitClear:**
  - **2025 report:** 211M changed lines, 2020–2024. "Moved" (refactored) code fell from ~25% of changed lines (2021) to under 10% (2024). Copy/paste overtook moved code for the first time. Duplicated blocks rose about 8× in 2024 ([DevClass](https://www.devclass.com/ai-ml/2025/02/20/ai-is-eroding-code-quality-states-new-in-depth-report/1626250)).
  - **2026 "Maintainability Gap" report:** 623M changes, 2023–2026. Block duplication up **81%** (40.3 to 73.0). Moved code at **3.8%** year-to-date. Error-masking constructs up 47%. Two-week churn up 15%. Updates to code older than a year down 74% ([GitClear](https://www.gitclear.com/the_ai_code_quality_maintainability_gap)).
  - **Caveats:** GitClear is a vendor, the reports show correlation only, they contain inconsistent units, and they do not explain how AI-authored code is detected.
- **Uplevel (2024):** about 800 developers. Copilot *access* brought no change in PR throughput and a **41% higher bug rate**. It measured access, not usage ([CIO](https://www.cio.com/article/3540579/devs-gaining-little-if-anything-from-ai-coding-assistants.html)).

### 4.5 Merge/acceptance rates of agent PRs (third-party)
- **AIDev dataset** (33,596 agent PRs in GitHub repos with 100+ stars, Dec 2024–Jul 2025) ([arXiv 2601.15195](https://arxiv.org/html/2601.15195)):

| Agent | PRs | Merge rate |
|---|---|---|
| OpenAI Codex | 21,799 | 82.6% |
| Cursor | 1,541 | 65.2% |
| Claude Code | 459 | 59.0% |
| Devin | 4,827 | 53.8% |
| GitHub Copilot | 4,970 | 43.0% |

  - Of 600 manually annotated rejections: **38%** were reviewer abandonment, **23%** duplicate PRs, **17%** CI or test failures, and 3% incorrect implementation.
  - **Each additional failed CI check cut merge odds by ~15%.** Documentation, CI and build tasks merged most often; bug fixes and performance work least. Unmerged PRs were larger.
- **Confounding** ([arXiv 2606.22711](https://arxiv.org/html/2606.22711v1)): pooled merge rates are misleading. Fully autonomous Copilot PRs merged 6.2% of the time against 47.4% co-authored, and Devin 21.6% against 55.1%. Controlling for repository collapses Devin's gap from +33.5 points to +1.6. Controlling for PR structure (single-commit `[WIP]` drafts) mostly removes Copilot's. The authors' advice: do not compare agents on pooled merge rates.
- **Security and fix PRs** ([arXiv 2601.00477](https://arxiv.org/html/2601.00477v2); [arXiv 2602.00164](https://arxiv.org/html/2602.00164v1)): same ordering, with Codex about 82–87% and Copilot about 42–50%.
- **Vendor-reported (not independent):** Devin's merge rate rose from 34% to 67% (Nov 2025). Augment's case study is in §3.13. Vercel's factory produced 25–35% of merged PRs. Atlassian claims a 45% cut in PR cycle time.

### 4.6 Adoption and market size (mostly vendor or press)
- **Developer surveys:**
  - Stack Overflow 2026 (Oct 2026): 65.9% use coding assistants or agents, 26.2% use automated agent workflows, only about **7%** trust AI output for important decisions, and about 48% trust it only when they can verify it ([press release](https://stackoverflow.co/company/press/archive/stack-overflow-annual-developer-survey-ai-trust-conditional); [The Register](https://www.theregister.com/software/2026/10/10/stack-overflow-survey-finds-devs-hooked-on-ai-but-not-totally-sold-on-its-judgment/5301662)).
  - DORA: 90% adoption.
- **Revenue and usage:**
  - Claude Code run-rate above $2.5B (Feb 2026).
  - Codex at 5M weekly active users (Jun 2026).
  - Cursor ARR about $3B (May 2026).
  - Lovable ARR above $600M (Sep 2026, reported).
  - Replit about $525M annualized (Apr 2026, Sacra estimate).
- **Valuations and rounds:**
  - Cognition $26B (May 2026).
  - Lovable $13.3B (Aug 2026).
  - Replit $9B (Mar 2026).
  - Factory $1.5B (Apr 2026, unverified).
  - Blitzy $1.4B (May 2026).
  - 8090: $135M Series A (Jun 2026).

**Bottom line:** Strong evidence exists only for higher *activity* (PRs, lines, tasks). Evidence on *delivery* (main-branch throughput, stability, company-level outcomes) is weak or negative, and the gains depend on engineering maturity. No independent ticket-to-merge benchmark exists.

---

## 5. Patterns that work and anti-patterns

### 5.1 Patterns that work
1. **Make the tracker or chat the control plane.** Assigning an issue to an agent, or @mentioning it, is now universal: Codex in Linear, Copilot in Jira (GA Jun 2026), Cursor in Slack and Linear, Devin in Slack, Teams, Jira and Linear, GitLab `@duo-developer`, Kiro `/kiro fix`, and Jira's agent picker. Users don't learn a new UI, and the agent inherits ticket context.
2. **Stream status back to where the request started, with a link to the full transcript.** Examples: Linear Activity, real-time progress in Jira, Slack thread updates plus a completion @mention with View Session and Create PR buttons, and a bot reaction plus "View session" on GitHub issues.
3. **Use an ephemeral, isolated sandbox per task, keep credentials outside it, and allowlist egress.** Claude routes git through a server-side proxy and keeps network secrets outside the VM. Codex and Kiro offer network policies (none, package managers only, or an allowlist). Ona runs in the customer's VPC. Cache setup scripts.
4. **Close the PR loop automatically.** Watch CI and review comments, push fixes when a fix is clear, and ask when a comment is ambiguous. Examples: Claude auto-fix, Copilot Agent Merge, Kiro `/kiro fix`, Cursor Bugbot Autofix, Augment PR Author. Failed CI is the single biggest code-level reason PRs go unmerged (−15% merge odds per failed check).
5. **Attach verification evidence to the PR**: screenshots, videos, logs, E2E runtime evidence (Cursor artifacts, Augment Verifier, Buildful's recorded browser QA). Reviewers trust evidence more than claims; Quesma traced Blitzy's benchmark lead to running the tests.
6. **Gate risky work at the plan stage**: spec or plan approval before coding (Kiro's Jira → spec → approval, Claude plan mode followed by cloud execution, GitLab planner), and human merge at the end.
7. **Review in tiers by risk.** Auto-approve low-risk changes (docs, dependency bumps), deep-review high-risk ones, and use feature flags and guarded rollout for the riskiest code (Augment Risk Analyzer, LaunchDarkly's factory).
8. **Keep tasks small, well-specified and verifiable.** Devin's own review and the AIDev data agree: migrations, tests, docs, CI and well-scoped tickets succeed, while large, ambiguous or performance work fails. Enforce PR size limits.
9. **Check for duplicates before opening a PR.** Duplicates are 23% of rejected agent PRs.
10. **Invest in repo readiness**: AGENTS.md / CLAUDE.md, setup scripts, fast reliable tests, CI that runs on agent commits (Factory's "Agent Readiness" scoring; GitLab's warning about missing runner config). DORA's "amplifier" finding says the same thing.
11. **Stay agent- and model-agnostic.** Tembo, GitLab external agents, GitHub Agent HQ, Jira's agent picker and OpenAI Symphony all assume agents get swapped often. Model leadership changes every few months.
12. **Measure outcomes, not activity**: time-to-merge, revert rate, first-attempt merge rate, cost per merged PR, and human touches per PR (Augment's 10–15 → ~3 is the right *kind* of metric). Watch queue build-up between stages.
13. **Learn from feedback**: capture review comments as standing rules (Kiro "learns from PRs and feedback," Factory "Signals," CLAUDE.md and skills).

### 5.2 Anti-patterns
1. **Counting PRs, lines or tasks as productivity.** Faros (+98% PRs, flat company outcomes), GitClear (duplication up 81%, refactoring collapsing) and CircleCI (feature branches +15%, main −7%) all show this.
2. **Flooding reviewers.** The top rejection reason is reviewer abandonment (38%), and review time rose 91%. A factory that opens PRs faster than humans can read them moves the bottleneck without removing it.
3. **Unbounded autonomy near production.** Replit's agent deleted a production database during a code freeze (Jul 2025). Keep production credentials and prod databases out of the sandbox, and require human approval for destructive operations.
4. **Feeding untrusted ticket or chat text into prompts unchecked.** Symphony, Claude in Slack and Kiro (MCP servers outside the sandbox) all warn about prompt injection and data exfiltration.
5. **Bot loops and side effects.** Agent replies can trigger comment-driven automation (Claude warns about Atlantis and Terraform Cloud). The Claude Action blocks bot actors by default to prevent loops.
6. **Changing requirements mid-task, or vague tickets.** Devin and Kiro both report quality drops. Restart with a revised spec instead.
7. **Opaque usage pricing.** Cursor (Jul 2025 backlash and refunds), Replit (effort-based), Claude Code (limit complaints in 2026), Copilot (premium requests, then credits) and Rovo (no published credit exchange rate) all show it. Parallel runs and retries bill at full price.
8. **Shipping generated apps without security review.** Lovable's RLS CVE exposed 170 apps.
9. **Trusting leaderboard numbers.** SWE-bench Verified is contaminated, SWE-bench Pro Public is self-reported, and Blitzy's audit was paid for.
10. **Single-host lock-in.** Claude Code cloud and Slack, Copilot, Jules and Codex Slack tasks are all GitHub-centric. GitLab, Bitbucket and self-hosted Gitea users are underserved.
11. **Depending on a single vendor's roadmap.** In 12 months: Rovo Dev standalone EOL, Q Developer IDE end of support, Codegen sunset, Sweep pivot, Cosmos sold, Windsurf rebranded, Cursor acquired, and Copilot and Devin pricing restructured.

---

## 6. Gaps and opportunities for a small self-hosted software factory (Claude Code CLI behind a model adapter)

**Where the market leaves room.** The big vendors are cloud-hosted, GitHub-first, priced in credits, and increasingly bundled: Cursor with Grok, Copilot with GitHub, Codex with ChatGPT, Rovo with Jira. Self-hosted options are either enterprise-priced (Factory on-prem, Devin VPC, Ona, Blitzy, 8090) or early open-source projects (OpenHands, Symphony, Multica, Cyrus). **Tembo** is the closest commercial analog (agent-agnostic, self-hostable, multi-tracker) and the benchmark to beat.

### 6.1 Opportunities (ranked by value for a small team)
1. **Intake that works with any tracker and any git host.** Normalize Slack, Linear, Jira, GitHub, **GitLab, Gitea/Forgejo, Bitbucket**, cron and API into one `WorkItem`, and mirror status back to the origin: thread replies, issue activity, labels. Hosted Claude Code, Copilot, Jules and Codex Slack tasks are GitHub-only, so this is a real gap.
2. **A full PR babysitting loop**, including what hosted tools miss:
   - Poll for **base-branch drift and merge conflicts** and rebase automatically. GitHub emits no webhook for this, so Claude's auto-fix cannot react to it.
   - Re-run flaky CI before blaming the code.
   - Dedupe against open PRs and issues before starting work.
   - Enforce PR size limits.
   - Stop after N fix attempts and escalate to a human.
3. **Outcome telemetry no vendor publishes:**
   - Per-task cost (tokens plus compute).
   - First-attempt merge rate.
   - Time to merge.
   - 14-day revert rate.
   - Human touches per PR.
   - Abandonment rate.

   Report these per repo and per task type. This answers the buyer's first question ([Hashnode buying advice](https://hashnode.com/blog/ai-software-factory)).
4. **Evidence-first PRs.** Every PR carries the test run, coverage delta, and Playwright screenshots or video for UI work, plus a short risk classification that drives the review tier.
5. **Security defaults:**
   - An ephemeral container or microVM per task.
   - Git credentials and secrets kept **outside** the sandbox behind a proxy (copy Anthropic's GitHub-proxy pattern).
   - An egress allowlist.
   - Ticket and Slack text treated as untrusted input with clear delimiting.
   - Bot-actor loop guards.
   - No production credentials, ever.
   - Least-privilege GitHub/GitLab app scopes (the Claude GitHub App asks for 13 permissions; a custom app needs only Contents, Issues and Pull requests).
6. **Durable, resumable runs.** Hosted cloud sessions lose running background work when the VM expires. Durable workflow state (for example a Temporal-style or DB-backed state machine) and idempotent steps make overnight or multi-day work reliable.
7. **Multi-repo and campaign mode.** Most hosted agents map one session to one repo and one PR (Copilot on Actions, Claude in Slack, Kiro). Coordinated multi-PR migrations across repos are underserved for small teams. Blitzy and Devin serve this only at enterprise prices.
8. **Learning loop.** Turn recurring review feedback into repo rules (CLAUDE.md / AGENTS.md, skills, hooks), with a human approving each rule change.
9. **Transparent, cheap economics.** Per-task budgets, `--max-turns`, wall-clock caps, a kill switch, and route cheap or low-risk tasks to cheaper models or harnesses.

### 6.2 Constraints specific to "Claude Code CLI behind a model adapter" (verify before building)
- **Non-Claude models are not supported through Claude Code.** Anthropic's gateway docs say it "doesn't support routing Claude Code to non-Claude models through any gateway," and gateways must keep up with new Claude Code features or those features break ([LLM gateway doc](https://code.claude.com/docs/en/llm-gateway.md)). **Implication:** put the adapter at the **harness** level, with Claude Code CLI, Codex CLI, OpenCode, Gemini CLI or Kiro CLI behind one interface (as Tembo and GitLab do), rather than only swapping models under Claude Code. Use the model level only for officially supported Claude providers: Anthropic API, Bedrock, Google Cloud Agent Platform/Vertex and Foundry.
- **Authentication and terms.** Reports say Anthropic blocked third-party tools from using Pro and Max subscription OAuth (from 9 Jan 2026) and that its terms bar third-party products from offering claude.ai login or rate limits "including agents built on the Claude Agent SDK" unless approved ([The New Stack](https://thenewstack.io/anthropic-claudecode-opencode-split/); [MindStudio](https://www.mindstudio.ai/blog/anthropic-openclaw-ban-oauth-authentication), secondary). For a factory shared by a team, plan on **API keys, a Console org, or a cloud-provider account**, ideally through workload-identity federation, which the Claude Action supports. Whether a single developer may run their own CLI with their own subscription inside personal automation is less clear. Confirm against Anthropic's current terms.
- **Use the supported automation surfaces:** headless `claude -p` with `--output-format stream-json` for status streaming, the Agent SDK for programmatic control, hooks for gating, `--allowedTools` / permission rules for least privilege, and managed settings (`allowedProviders`) to pin the gateway. Anthropic's cloud features (`--cloud`, teleport, auto-fix, Claude Tag) need a claude.ai account and do not work with third-party providers, so a self-hosted factory has to rebuild that loop itself.
- **Rate limits and cost.** Subscription limits are shared and have shifted repeatedly in 2026. Parallel agents multiply cost. Budget per task at API rates.

### 6.3 Suggested positioning
"A self-hosted factory for small teams that works with any tracker and any git host. It ships small, evidence-backed PRs, babysits them to merge, and reports cost and merge outcome per task, with the coding harness and model as swappable plugins." It differs from Tembo on self-hosting simplicity and outcome telemetry, from OpenHands and Symphony on production polish of the PR loop, and from the vendors on not being tied to GitHub or to one model.

---

## 7. Sources

**Factory:** https://factory.com/pricing · https://factory.ai/news/series-b · https://docs.factory.com/ · https://docs.factory.ai/cli/byok/overview · https://rywalker.com/research/factory-ai · https://www.implicator.ai/factorys-50m-bet-on-agent-native-coding-meets-a-noisy-market/

**Cognition / Devin:** https://devin.ai/pricing · https://docs.devin.ai/integrations/overview · https://cognition.com/blog/devin-annual-performance-review-2025 · https://en.wikipedia.org/wiki/Cognition_AI · https://www.answer.ai/posts/2025-01-08-devin · https://www.theregister.com/2025/01/23/ai_developer_devin_poor_reviews

**OpenAI Codex:** https://learn.chatgpt.com/docs/cloud · https://learn.chatgpt.com/docs/pricing · https://learn.chatgpt.com/docs/third-party/linear · https://linear.app/changelog/2025-12-04-openai-codex-agent · https://www.infoworld.com/article/4070541/openai-codex-adds-sdk-admin-tools-slack-integration.html · https://www.constellationr.com/insights/news/openai-touts-broadening-codex-usage-5-million-weekly-active-users · https://codex.danielvaughan.com/2026/04/08/codex-cloud-task-application/

**Anthropic Claude Code:** https://code.claude.com/docs/en/platforms · https://code.claude.com/docs/en/claude-code-on-the-web.md · https://code.claude.com/docs/en/slack · https://code.claude.com/docs/en/github-actions · https://code.claude.com/docs/en/llm-gateway.md · https://claude.com/pricing · https://www.theregister.com/2026/01/05/claude_devs_usage_limits/ · https://thenewstack.io/anthropic-claudecode-opencode-split/ · https://www.mindstudio.ai/blog/anthropic-openclaw-ban-oauth-authentication · https://venturebeat.com/technology/anthropic-says-it-hit-a-30-billion-revenue-run-rate-after-crazy-80x-growth

**GitHub Copilot:** https://github.com/features/copilot/agents · https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent · https://github.blog/changelog/2025-09-25-copilot-coding-agent-is-now-generally-available/ · https://github.blog/changelog/2026-06-25-github-copilot-for-jira-is-now-generally-available/ · https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/ · https://devtoolsreview.com/pricing/copilot-pricing/ · https://github.com/orgs/community/discussions/163868

**Cursor:** https://cursor.com/docs/cloud-agent · https://cursor.com/pricing · https://cursor.com/changelog/03-05-26 · https://cursor.com/blog/may-2026-bugbot-changes · https://en.wikipedia.org/wiki/Cursor_(company) · https://www.teslarati.com/spacex-just-combined-grok-cursor-and-x-into-one-mega-plan/

**Google Jules:** https://jules.google/ · https://www.morphllm.com/comparisons/jules-google-coding-agent · https://www.sinatra.dev/blog/google-jules-review

**Amazon Kiro / Q Developer:** https://kiro.dev/pricing/ · https://www.aboutamazon.com/news/aws/amazon-ai-frontier-agents-autonomous-kiro · https://builder.aws.com/content/3DZ4AIZNUZCq8SWDUlGc7Ort7qx/hands-on-with-kiro-web-preview-inside-kiro-web-preview-two-real-builds-powers-mcp-and-kiro-fix-on-github-issues · https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-developer-ide-end-of-support.html · https://dev.to/aws-builders/aws-catching-up-on-the-basic-functions-of-kiro-autonomous-agent-preview-frontieragents-5e85

**Atlassian Rovo Dev / Jira:** https://www.atlassian.com/software/rovo-dev · https://www.atlassian.com/licensing/rovo-dev · https://dev.to/mihai_leanzero/rovo-dev-pricing-after-end-of-life-standard-cli-credits-4p9c · https://www.atlassian.com/software/jira/dev

**GitLab Duo Agent Platform:** https://about.gitlab.com/blog/gitlab-duo-agent-platform-is-generally-available/ · https://docs.gitlab.com/user/duo_agent_platform/flows/foundational_flows/developer.html · https://docs.gitlab.com/subscriptions/gitlab_credits

**Replit:** https://docs.replit.com/billing/ai-billing · https://dealroom.co/news/126729-replit-confirms-400m-series-d-at-9b-valuation-launches-agent-4-to-let-an/ · https://www.techtarget.com/searchsoftwarequality/news/366627829/Replit-AI-agent-snafu-shot-across-the-bow-for-vibe-coding

**Lovable:** https://dealroom.co/news/144597-lovable-raises-400m-at-13-3b-valuation-eyes-600m-revenue-run-rate/ · https://superblocks.com/blog/lovable-vulnerabilities · https://bastion.tech/blog/lovable-april-2026-data-breach

**Augment / Cosmos / Harness:** https://www.augmentcode.com/pricing · https://www.augmentcode.com/blog/beyond-ai-coding-agents-how-we-built-augments-software-factory · https://docs.augmentcode.com/cosmos/software-factory/overview · https://www.harness.io/blog/harness-acquires-augment-code-cosmos · https://thenewstack.io/harness-augment-cosmos-acquisition/

**Sweep / Codegen:** https://platform.jetbrains.com/t/sweep-ai-coding-assistant-purpose-built-for-jetbrains/1317 · https://aiwiki.ai/wiki/sweep_ai · https://clickup.com/blog/clickup-codegen-acquisition/ · https://www.orrick.com/en/News/2025/12/Codegen-Acquired-by-ClickUp

**Tembo / Blitzy:** https://www.tembo.io/pricing · https://en.wikipedia.org/wiki/Blitzy · https://quesma.com/blog/verifying-blitzy-swe-bench-pro/ · https://siliconangle.com/2026/05/05/blitzy-raises-200m-1-4b-valuation-deploy-thousands-coding-agents-parallel/

**Newer entrants / ecosystem:** https://igoro.com/archive/software-factories/ · https://hashnode.com/blog/ai-software-factory · https://github.com/varun1505/awesome-software-factories · https://www.usagepricing.com/blueprint/activity/warp-2026-08-packaging · https://www.theregister.com/2025/09/03/gitpod_rebrands_as_ona/ · https://thenextweb.com/news/chamath-palihapitiya-8090-135m-series-a-ai-coding · https://docs.all-hands.dev/usage/cloud/project-management/overview · https://www.openhands.dev/blog/open-source-ai-coding-agents · https://betterstack.com/community/guides/ai/openai-symphony/

**Benchmarks:** https://x.com/OpenAIDevs/status/2026002219909427270 · https://www.codesota.com/news/swe-bench-contamination-debate · https://benchlm.ai/benchmarks/swe-bench-verified · https://llm-stats.com/benchmarks/swe-bench-verified · https://arxiv.org/pdf/2509.16941 · https://labs.scale.com/leaderboard/swe_bench_pro_public_v2 · https://www.morphllm.com/swe-bench-pro

**Productivity and quality studies:** https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/ · https://metr.org/blog/2026-02-24-uplift-update/ · https://blog.robbowley.net/2026/04/04/metrs-developer-productivity-research-2026-update/ · https://blog.google/technology/developers/dora-report-2025/ · https://www.infoq.com/news/2025/09/dora-state-of-ai-in-dev-2025 · https://getunblocked.com/blog/ai-productivity-paradox/ · https://faros.ai/research · https://circleci.com/blog/five-takeaways-2026-q3-pulse/ · https://blog.robbowley.net/2026/04/02/more-code-less-delivery-but-does-the-circleci-2026-report-really-show-1-in-20-teams-are-benefiting/ · https://www.gitclear.com/the_ai_code_quality_maintainability_gap · https://www.devclass.com/ai-ml/2025/02/20/ai-is-eroding-code-quality-states-new-in-depth-report/1626250 · https://www.cio.com/article/3540579/devs-gaining-little-if-anything-from-ai-coding-assistants.html

**Agent PR merge-rate studies:** https://arxiv.org/html/2601.15195 · https://arxiv.org/html/2606.22711v1 · https://arxiv.org/html/2601.00477v2 · https://arxiv.org/html/2602.00164v1

**Surveys:** https://stackoverflow.co/company/press/archive/stack-overflow-annual-developer-survey-ai-trust-conditional · https://www.theregister.com/software/2026/10/10/stack-overflow-survey-finds-devs-hooked-on-ai-but-not-totally-sold-on-its-judgment/5301662
