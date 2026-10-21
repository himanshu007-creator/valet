create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  push_subscription jsonb,
  created_at timestamptz not null default now()
);

alter table users add column if not exists push_subscription jsonb;

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('in', 'callback')),
  bolna_call_id text,
  from_phone text,
  transcript jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id),
  tickets text[] not null,
  created_at timestamptz not null default now()
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id),
  ticket_id text not null,
  title text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'blocked', 'failed', 'timeout')),
  branch text,
  pr_url text,
  doc_path text,
  question text,
  answer text,
  log_tail text,
  started_at timestamptz,
  finished_at timestamptz
);

-- reproduced live: a caller who phones in fresh (not via a callback) could hear "nothing
-- running" and never learn that N tickets finished or failed while they were away — the
-- overview only ever looked at active (queued/running/blocked) jobs. delivered_at tracks
-- whether a terminal outcome has actually been spoken to the caller at least once; the
-- overview surfaces anything still null regardless of how long ago it finished, then marks it
-- delivered. Deliberately NOT set from the outbound-callback trigger path (that's a fire-and-
-- forget call that can go unanswered or get spam-blocked, confirmed happening this session) —
-- only set when genuinely spoken during a live call, so nothing can be silently lost.
alter table jobs add column if not exists delivered_at timestamptz;
