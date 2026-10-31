# Software Factory — working notes for Claude

Read `README.md` first; it is accurate. These are the facts that save time.

- App root `~/Self/software-factory`. Server `server/index.ts` runs directly under Node 22.18+ (25 on this Mac; native
  TypeScript, no build; `.ts` import extensions, `verbatimModuleSyntax`, `erasableSyntaxOnly`).
  Client `web/` is Vite + React, built to `web/dist`, served by the same process. Port **8282**,
  binds 127.0.0.1. `npm run typecheck` checks both; `npm test` runs `test/*.test.ts` against the
  `factory_test` database (`.env.test`).
- Database `factory` in the shared platform Postgres (`~/Self/dashboard/platform`), role `factory`,
  password `DB_PASSWORD_FACTORY` in `platform/.env`; `DATABASE_URL` in `.env` here. Migrations are
  `server/migrations/*.sql`, applied at boot in order; add a new numbered file, never edit an old one.
- Production is the launchd unit **com.factory.web** (`ops/launchd.sh`), logs in `data/logs/web.log`,
  registered in rack via `dashboard.json`; the Deploy button runs `make deploy`. A deploy interrupts
  running agent sessions: they are marked interrupted and their items parked as blocked (retryable).
- **No API key on this machine.** Agents are the `claude` CLI (`claude -p --output-format stream-json`)
  on the subscription login, behind `server/lib/runners/`. Never add the Anthropic SDK. Never use
  `--bare` (it ignores the subscription login). The child environment is an allow-list
  (`childEnv` in `runners/index.ts`).
- **Sign-in** is Google OIDC (`server/lib/auth.ts`, same pattern and OAuth client as `~/Self/me`);
  roles admin/member/viewer/pending; API tokens `ft_…`. `DEV_LOGIN=1` allows `POST /api/auth/dev`
  locally. The gate is in `server/index.ts`.
- The pipeline (`server/lib/pipeline.ts`) is the only thing that moves items. `lib/discover.ts` finds local checkouts for "Add from this Mac"; `lib/digest.ts` is the daily word; `lib/alerts.ts` tells admins about new sign-ins; `lib/prwatch.ts` reads pull requests back. Statuses are in
  `items.ts` (`STATUSES`). Add intake as a `SourceAdapter` (`lib/sources/`), agents as an
  `AgentRunner` (`lib/runners/`), status targets as posters (`conversations.ts`).
- Telegram goes through `~/Self/notifier` (`NOTIFIER_URL`); its button presses come back to
  `/api/notifier/hook` (before the session gate, local only, bearer secret in `kv`).
- Moving items: `setStatus` is guarded (closed items need `force`), `claim()` for merge/deploy, every
  repository operation under `withRepoLock`. A merge conflict starts `reconcile()`; `retry()` resumes
  at `failed_stage`.
- Data: `data/repos/<slug>` clones, `data/work/<slug>/<item>` worktrees, `data/logs`. All gitignored.
- Style: short comments that say why, no ORMs, few dependencies, plain words in UI copy.
