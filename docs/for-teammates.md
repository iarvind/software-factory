# Using the factory (for everyone on the team)

**Sign in** with Google at the factory's address. The first time, an admin lets you in (they get
a Telegram message); after that you stay signed in on that device for 90 days.

## Ask for something

| from | how |
|---|---|
| the web | **New request** on the Board: a title, what you want and why, which project. |
| Slack | `@factory <what you want>` in a channel the bot is in, a direct message to the bot, `/factory <what you want>` (`/factory status` tells you what is going on), or react to any message with the trigger emoji (`:factory:` unless your admin chose another). The factory answers in a thread. |
| Jira / Linear / GitHub | put the `factory` label on the issue. |
| Telegram | `/build <project> <what you want>`. |
| a terminal | `factory new <project> "<title>" --body -` (see Settings → My API tokens). |

Write it the way you would brief a careful colleague: what, where, what "done" looks like, what
not to touch. The planner will ask if it truly cannot proceed; otherwise it makes a sensible
assumption and says so.

## What happens next

1. **Plan** — an agent reads the repository and writes a short plan (size, risk, steps, how it will
   be verified, what done means). Depending on the project, a person approves it, or it goes ahead.
2. **Build** — the agent works on its own branch, runs the tests, commits.
3. **Verify** — the factory runs the project's tests and build itself. Failures go back to the agent.
4. **Review** — a second agent reads the diff; then a pull request opens (or the diff waits on the
   item page for projects that merge locally). Your comments become fix rounds.
5. **Merge** and **deploy** — each behind a gate the project chose.
6. **Done** — the factory tells you where you asked, and writes down what it learned.

You can follow every step live on the item page, or `factory watch <id>`.

## Answer, approve, steer

- **Questions** from the planner: reply in the Slack thread, comment on the ticket, or on the item page.
- **Approvals**: buttons in Slack and Telegram, `approve` / `reject` as a comment on the ticket or
  issue, the Board's "Needs you" strip, or `factory approve <id>`. Some sources restrict who may.
- **Review**: approve or request changes on the pull request as usual; on local projects, use the
  item page's Changes tab and the Approve / Request changes buttons. `changes: …` as a comment works too.
- **Stop**: Cancel on the item page or `factory cancel <id>`. An admin can pause the whole factory.
- **Teach**: a note in the project's book ("run `make db` before the tests") reaches every later job.

## Good requests

- One change per request. "Add CSV export to the reports page" rather than "improve reports".
- Name the file, page or endpoint when you know it.
- Say what must not change.
- If you have a strong opinion on how, say it; otherwise let the planner choose and read the plan.
