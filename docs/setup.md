# Setting things up

## Google sign-in

The same OAuth client as the other apps on this Mac (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
in `.env`). In Google Cloud Console → APIs & Services → Credentials → that client → *Authorized
redirect URIs*, add:

- `http://127.0.0.1:8282/api/auth/google/callback` for local use
- `https://<factory host>/api/auth/google/callback` once it has a public hostname

Then `ADMIN_EMAILS=you@gmail.com`. Anyone else who signs in is *pending* until an admin lets them
in from **People**, unless their address is in `ALLOWED_EMAILS` or their domain in
`ALLOWED_DOMAINS`.

## A public hostname (optional)

Like every app here: in `~/Self/dashboard/platform`, add `FACTORY_HOST=factory.<domain>` to `.env`,
`FACTORY_HOST: ${FACTORY_HOST:-factory.localhost}` under `caddy.environment` in `compose.yml`, a
site block in `Caddyfile`:

```
http://{$FACTORY_HOST} {
	import app
	reverse_proxy host.docker.internal:8282 {
		header_up X-Real-IP {http.request.header.CF-Connecting-IP}
		header_up X-Forwarded-Proto https
		flush_interval -1
	}
}
```

(`flush_interval -1` so the live event stream is not buffered), then
`docker compose up -d --force-recreate caddy`. Set `APP_ORIGIN=https://factory.<domain>` in the
factory's `.env` and `make deploy`. Requests through the tunnel need a session; `DEV_LOGIN` and the
notifier hook refuse them.

## Your first project

For an app on this Mac: Projects → **Add from this Mac**. It lists the git checkouts one level
under rack's roots (`roots` in `~/Self/dashboard/services.json`, `~/Self` when there is none) that
are not projects yet — worktrees are left out — with the commands filled in from what the
repository has: `package.json` scripts (`npm test`, `npm run typecheck` or `npm run build`,
`npm ci`), Makefile targets (`make test`, `make check`, `make deploy`), `go.mod`, `pytest`, the
health check from its `dashboard.json`, and the first paragraph of its README as instructions.
Look them over, change what is wrong, add. It is created with `delivery` `local` and the default
gates.

By hand it is Projects → New: `local_path` `~/Self/<app>`, `delivery` `local`, `test_command` and
`build_command` what its README says (`npm test`, `npm run typecheck`), `deploy_command`
`make deploy`, `health_url` `http://127.0.0.1:<port>/api/healthz`. Keep the gates `manual` until
the factory has earned `auto_low_risk`. *Check* tells you whether the checkout is clean and on its
default branch (a local merge refuses otherwise).

For a repository on GitHub: `repo_url` (ssh or https; `gh` is logged in on this Mac and git uses
ssh), `delivery` `pr`. The factory clones into `data/repos/<slug>`, opens pull requests, reads
reviews and checks back, merges with `gh pr merge --squash`.

## Slack

Create an app from the manifest the Sources page shows for the Slack kind (Socket Mode on; bot
scopes `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`,
`chat:write`, `reactions:read`, `reactions:write`, `users:read`, `commands`; events `app_mention`,
`message.im`, `message.mpim`, `message.channels`, `message.groups`, `reaction_added`; slash
command `/factory`; interactivity on). An app made from an older manifest lacks `message.mpim`:
add it under Event Subscriptions, then reinstall. Install it to your workspace only (apps shared
across workspaces get a far lower history rate limit). Copy the **app-level token** (`xapp-…`,
scope `connections:write`) and the **bot token** (`xoxb-…`) into a Slack source. Invite the bot to
the channels it should listen in. Then `@factory fix the date picker on the gym page`, or
`/factory …`, or react with the trigger emoji. Replies in the thread are answers and review
feedback; approvals are buttons in the thread. Mentioning the bot again in the thread of a request
that is done, failed or cancelled starts a new request, linked to the old one.

List the **trigger channels** by id: besides limiting where requests start, they are the channels
the factory reads back after a restart or a dropped connection (from the newest message it saw),
so a mention or the trigger emoji on a message posted meanwhile still becomes a request. Mentions
inside threads during such a gap are not recovered. A bad token or a missing scope stops the
connection and shows on the source; a Slack outage is retried on its own, with backoff.

### Who may decide from a chat or a ticket

Every chat and ticket source has a **Who may approve** field: the people who may approve or reject
a gate by button or by comment, comma-separated. It matches identities their owners cannot simply
rename, never display names:

- Slack: member ids (`U…`; profile → ⋮ → *Copy member ID*) or usernames. Buttons match either;
  replies in a thread match the member id only. People from another workspace in a Slack Connect
  channel never decide; their replies are kept as comments.
- Jira: account ids (the end of the person's profile URL, `…/jira/people/<id>`) or email
  addresses. Profile privacy often hides emails from the API, so prefer account ids.
- GitHub: logins.
- Linear: email addresses or user ids.

Case and a leading `@` do not matter. Left empty, anyone who can write there decides — fine for a
private Telegram chat or your own Slack workspace, not for a public repository. Pull-request
comments on GitHub count only from the repository's owners, members and collaborators, whatever
the field says.

## Jira

A Jira source needs the site URL, your email and an API token
(id.atlassian.com → Security → API tokens). With a scoped API token the base URL is
`https://api.atlassian.com/ex/jira/<cloudId>`; then also fill in the **site URL**
(`https://yourteam.atlassian.net`) so links to issues open on the site. The JQL decides what is
work (default `labels = factory AND statusCategory != Done`); the factory adds `factory-picked`
when it takes an issue, comments its status (long comments are cut to Jira's limit), treats new
comments as feedback, and a comment of just `approve` or `reject` decides a pending gate.
Optionally name a transition to apply when done. Once a request is closed, an issue that is moved
out of a done status, or given a label the JQL asks for again, becomes a new request linked to the
old one; other updates to it are left alone.

## GitHub issues

A GitHub source needs `owner/repo` and either a fine-grained token (Issues: read & write,
Contents: read, Pull requests: read & write) or nothing — then it uses the `gh` login on this Mac.
Label an issue `factory` to hand it over. With *Only collaborators* on, requests and comments count
from owners, members and collaborators — and from anyone the collaborator permission API says has
write, maintain or admin access, which covers organisation members whose membership is private.
Reopening an issue, or putting the label back on, after its request closed starts a new request
linked to the old one. Pull requests are read back automatically for every project with delivery
`pr`.

## Linear

A personal API key (Settings → Security & access → Personal API keys; `lin_api_…`) or an OAuth
access token, optionally a team key, and the trigger label. Once a request is closed, putting the
label back on its issue, or moving the issue back into the trigger states (by default any state
that is not completed or canceled), starts a new request linked to the old one.

## Schedules and watches

A *schedule* source is a request on a timer (`cron` like `30 2 * * 1-5`, or an interval; one of
the two is required): nightly "read `data/logs/web.log` for errors of the last day and fix what
you can", weekly dependency bumps. A *watch* polls a URL and fires on a condition: a health
endpoint not answering 2xx, a JSON number over a threshold, a phrase in a log. One open item at a
time per source: while one is open, a schedule skips its run and a watch stays quiet.

## Webhooks

A *webhook* source gets its own URL (`/api/hooks/<token>`); POST `{"title": "…", "body": "…",
"externalId": "…", "url": "…", "priority": 2}` from CI, monitoring or another app.

## Telegram

With `NOTIFIER_URL` set, important moments (questions, approvals, ready for review, done,
blocked) go to the notifier's Telegram channel with buttons. Commands: `/factory` (what is going
on), `/approvals`, `/build <project-slug> <request>`. In a group with more people than approvers,
set `TELEGRAM_APPROVER_IDS` (Telegram user ids, comma-separated) to say who may press the
buttons and ask for work.

## Runners

`RUNNER=claude` by default (`CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_SMALL_MODEL` for triage, review
and notes, `CLAUDE_EFFORT`). Projects may pick `codex` or `gemini` (`CODEX_BIN`, `GEMINI_BIN`)
or `fake` (no model; for trying the pipeline). To bill a team's work to an API key or a cloud
account instead of a personal subscription, put the variables in `.env` and list their names in
`CLAUDE_ENV_PASSTHROUGH` (e.g. `ANTHROPIC_API_KEY`); nothing else from the factory's environment
ever reaches an agent.

## The command line

`make install-cli` links `cli/factory.ts` to `~/.local/bin/factory`. Create a token under
Settings → My API tokens, then in your shell:

```sh
export FACTORY_URL=http://127.0.0.1:8282   # or the public hostname
export FACTORY_TOKEN=ft_…
factory status
```

## Budgets, the daily word, and who gets in

- **Settings → Daily budget**: once the API-equivalent spend of the day reaches it, nothing new
  starts until tomorrow (running jobs finish their step). 0 means no cap. Each project also caps
  a run (`maxBudgetUsd`) and a whole job (twice that, fix rounds included).
- **Settings → Digest hour**: once a day the factory posts what shipped, what waits on whom and
  what it cost — to Telegram, and to every Slack source with a status channel. −1 turns it off.
- **Settings → New accounts**: `pending` (an admin lets them in from People; admins are told on
  Telegram) or `viewer` (they can look straight away).

