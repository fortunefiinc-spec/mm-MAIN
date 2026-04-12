-- MailMate Supabase Schema v4
-- Run in Supabase SQL Editor

-- USERS
create table if not exists users (
  id             bigserial primary key,
  telegram_id    bigint unique not null,
  name           text not null default 'Gebruiker',
  credits        integer not null default 10,
  concept_count  integer not null default 0,
  style_profiles jsonb not null default '{"default":""}',
  active_style   text not null default 'default',
  user_knowledge text not null default '',
  onboarded      boolean not null default false,
  vakgebied      text not null default '',
  doel           text not null default '',
  toon_voorkeur  text not null default '',
  webhook_key    text not null default '',
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create index if not exists users_telegram_id_idx on users(telegram_id);

-- HISTORY
create table if not exists history (
  id          bigserial primary key,
  telegram_id bigint not null references users(telegram_id) on delete cascade,
  subject     text not null default 'Mail',
  concept     text not null default '',
  created_at  timestamptz default now()
);
create index if not exists history_telegram_id_idx on history(telegram_id);

-- GLOBAL KNOWLEDGE
create table if not exists global_knowledge (
  id         bigserial primary key,
  title      text not null,
  content    text not null,
  created_at timestamptz default now()
);

-- FOLLOW-UPS
create table if not exists followups (
  id          bigserial primary key,
  telegram_id bigint not null,
  subject     text not null,
  remind_at   timestamptz not null,
  sent        boolean not null default false,
  created_at  timestamptz default now()
);
create index if not exists followups_remind_idx on followups(remind_at, sent);

-- KLANTENDOSSIER (nieuw in v4)
create table if not exists clients (
  id            bigserial primary key,
  telegram_id   bigint not null,
  email         text not null,
  last_subject  text not null default '',
  contact_count integer not null default 0,
  last_contact  timestamptz default now(),
  notes         text not null default '',
  created_at    timestamptz default now()
);
create unique index if not exists clients_unique_idx on clients(telegram_id, email);

-- TEMPLATES (nieuw in v4)
create table if not exists templates (
  id          bigserial primary key,
  telegram_id bigint not null,
  name        text not null,
  content     text not null,
  created_at  timestamptz default now()
);
create index if not exists templates_telegram_id_idx on templates(telegram_id);

-- SECURITY
alter table users            disable row level security;
alter table history          disable row level security;
alter table global_knowledge disable row level security;
alter table followups        disable row level security;
alter table clients          disable row level security;
alter table templates        disable row level security;

-- GRANTS
grant all on users, history, global_knowledge, followups, clients, templates to anon, authenticated, service_role;
grant usage on all sequences in schema public to anon, authenticated, service_role;
