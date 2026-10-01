create table if not exists public.telegram_auto_reply_rules (
  id bigint generated always as identity primary key,
  enabled boolean not null default true,
  match_type text not null check (match_type in ('new_chat','exact','contains','starts_with','ends_with','default')),
  trigger_text text,
  reply_text text not null,
  priority integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_seen_chats (
  business_connection_id text not null,
  chat_id bigint not null,
  first_seen_at timestamptz not null default now(),
  primary key (business_connection_id, chat_id)
);

alter table public.telegram_auto_reply_rules enable row level security;
alter table public.telegram_seen_chats enable row level security;

revoke all on table public.telegram_auto_reply_rules from anon, authenticated;
revoke all on table public.telegram_seen_chats from anon, authenticated;
grant select, insert, update, delete on table public.telegram_auto_reply_rules to service_role;
grant select, insert, update, delete on table public.telegram_seen_chats to service_role;
grant usage, select on sequence public.telegram_auto_reply_rules_id_seq to service_role;

create index if not exists telegram_auto_reply_rules_enabled_priority_idx
  on public.telegram_auto_reply_rules (enabled, priority, id);

insert into public.telegram_auto_reply_rules (match_type, trigger_text, reply_text, priority)
select 'new_chat', null, 'Hello 👋 Thanks for messaging me. How can I help you?', 1
where not exists (select 1 from public.telegram_auto_reply_rules where match_type = 'new_chat');
