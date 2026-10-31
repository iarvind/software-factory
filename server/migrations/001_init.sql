-- The factory's whole schema. People, what they asked for, what the agents did about it,
-- every event along the way, the gates people decide at, and what was learned.

create table users (
  id            bigserial primary key,
  email         text not null unique,
  name          text,
  picture       text,
  role          text not null default 'member' check (role in ('admin', 'member', 'viewer', 'pending')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  disabled_at   timestamptz
);

create table sessions (
  id            bigserial primary key,
  token_hash    text not null unique,
  user_id       bigint not null references users(id) on delete cascade,
  user_agent    text,
  ip            text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);

create table api_tokens (
  id            bigserial primary key,
  user_id       bigint not null references users(id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,
  prefix        text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create table projects (
  id              bigserial primary key,
  slug            text not null unique,
  name            text not null,
  description     text,
  repo_url        text,
  local_path      text,
  default_branch  text not null default 'main',
  runner          text,
  model           text,
  effort          text,
  setup_command   text,
  test_command    text,
  build_command   text,
  deploy_command  text,
  health_url      text,
  delivery        text not null default 'pr' check (delivery in ('pr', 'local')),
  gates           jsonb not null default '{"plan": "manual", "merge": "manual", "deploy": "manual"}',
  limits          jsonb not null default '{}',
  tools           jsonb not null default '{"mode": "edit", "allow": [], "deny": []}',
  env             jsonb not null default '{}',
  instructions    text,
  paused          boolean not null default false,
  created_by      bigint references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table sources (
  id              bigserial primary key,
  project_id      bigint references projects(id) on delete set null,
  kind            text not null,
  name            text not null,
  config          jsonb not null default '{}',
  secrets         text,
  enabled         boolean not null default true,
  interval_sec    integer,
  cron            text,
  cursor          jsonb not null default '{}',
  state           jsonb not null default '{}',
  last_polled_at  timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  created_by      bigint references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table work_items (
  id              bigserial primary key,
  project_id      bigint references projects(id) on delete set null,
  source_id       bigint references sources(id) on delete set null,
  external_id     text,
  external_url    text,
  origin          jsonb not null default '{}',
  title           text not null,
  body            text not null default '',
  kind            text,
  size            text,
  risk            text,
  priority        integer not null default 3,
  status          text not null default 'inbox',
  gate            text,
  plan            jsonb,
  branch          text,
  worktree        text,
  base_sha        text,
  head_sha        text,
  pr_url          text,
  pr_number       integer,
  requester_id    bigint references users(id) on delete set null,
  requester_name  text,
  assignee_id     bigint references users(id) on delete set null,
  labels          text[] not null default '{}',
  cost_usd        numeric not null default 0,
  turns           integer not null default 0,
  fix_rounds      integer not null default 0,
  verify_rounds   integer not null default 0,
  error           text,
  paused          boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  due_at          timestamptz
);
create unique index work_items_external on work_items (source_id, external_id) where external_id is not null;
create index work_items_status on work_items (status, updated_at);
create index work_items_project on work_items (project_id, updated_at);

create table runs (
  id            bigserial primary key,
  item_id       bigint not null references work_items(id) on delete cascade,
  kind          text not null,
  runner        text not null,
  model         text,
  effort        text,
  session_id    text,
  status        text not null default 'queued',
  worktree      text,
  branch        text,
  prompt        text,
  result        text,
  structured    jsonb,
  cost_usd      numeric,
  turns         integer,
  usage         jsonb,
  exit_code     integer,
  error         text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
create index runs_item on runs (item_id, id);

create table events (
  id        bigserial primary key,
  item_id   bigint references work_items(id) on delete cascade,
  run_id    bigint references runs(id) on delete cascade,
  type      text not null,
  level     text not null default 'info',
  message   text,
  data      jsonb,
  actor     text,
  at        timestamptz not null default now()
);
create index events_item on events (item_id, id);
create index events_run on events (run_id, id);
create index events_at on events (at);

create table approvals (
  id            bigserial primary key,
  item_id       bigint not null references work_items(id) on delete cascade,
  kind          text not null,
  status        text not null default 'pending',
  summary       text,
  payload       jsonb,
  requested_at  timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    bigint references users(id) on delete set null,
  decided_via   text,
  note          text
);
create index approvals_pending on approvals (status, requested_at);

create table feedback (
  id          bigserial primary key,
  item_id     bigint not null references work_items(id) on delete cascade,
  run_id      bigint references runs(id) on delete set null,
  source      text not null,
  author      text,
  body        text not null,
  kind        text not null default 'comment',
  external_id text,
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index feedback_external on feedback (item_id, source, external_id) where external_id is not null;

create table posts (
  id          bigserial primary key,
  item_id     bigint references work_items(id) on delete cascade,
  target      text not null,
  ref         jsonb,
  body        text,
  ok          boolean not null default true,
  error       text,
  created_at  timestamptz not null default now()
);

create table notes (
  id          bigserial primary key,
  project_id  bigint references projects(id) on delete cascade,
  item_id     bigint references work_items(id) on delete set null,
  author      text not null,
  body        text not null,
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now()
);

create table kv (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create table audit (
  id        bigserial primary key,
  user_id   bigint references users(id) on delete set null,
  action    text not null,
  target    text,
  data      jsonb,
  at        timestamptz not null default now()
);
