-- MailMate Supabase Schema v2
-- Kopieer en plak in Supabase → SQL Editor → Run

-- ── USERS ────────────────────────────────────────────
create table if not exists users (
  id             bigserial primary key,
  telegram_id    bigint unique not null,
  name           text not null default 'Gebruiker',
  credits        integer not null default 10,
  concept_count  integer not null default 0,
  style_profile  text not null default '',
  user_knowledge text not null default '',
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create index if not exists users_telegram_id_idx on users(telegram_id);

-- ── HISTORY ──────────────────────────────────────────
create table if not exists history (
  id          bigserial primary key,
  telegram_id bigint not null references users(telegram_id) on delete cascade,
  subject     text not null default 'Mail',
  created_at  timestamptz default now()
);
create index if not exists history_telegram_id_idx on history(telegram_id);

-- ── GLOBALE KENNISBANK (admin beheert, iedereen gebruikt) ──
create table if not exists global_knowledge (
  id         bigserial primary key,
  title      text not null,
  content    text not null,
  created_at timestamptz default now()
);

-- ── SECURITY ─────────────────────────────────────────
alter table users            disable row level security;
alter table history          disable row level security;
alter table global_knowledge disable row level security;

-- ── KLAAR ────────────────────────────────────────────
-- Kopieer naar Railway:
-- SUPABASE_URL = https://JOUWPROJECT.supabase.co
-- SUPABASE_KEY = service_role key (Settings → API)
