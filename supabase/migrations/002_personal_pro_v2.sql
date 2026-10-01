create extension if not exists pgcrypto;

create table if not exists public.telegram_media_library (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  media_type text not null check (media_type in ('voice','audio','photo','video','document')),
  telegram_file_id text not null,
  telegram_file_unique_id text,
  mime_type text,
  file_name text,
  duration_seconds integer,
  file_size bigint,
  created_by_telegram_user_id bigint,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.telegram_pending_media_uploads (
  telegram_user_id bigint primary key,
  source_chat_id bigint not null,
  source_message_id bigint not null,
  media_type text not null check (media_type in ('voice','audio','photo','video','document')),
  telegram_file_id text not null,
  telegram_file_unique_id text,
  mime_type text,
  file_name text,
  duration_seconds integer,
  file_size bigint,
  received_at timestamptz not null default now()
);

create table if not exists public.telegram_conversation_states (
  business_connection_id text not null,
  chat_id bigint not null,
  source_rule_id bigint references public.telegram_auto_reply_rules(id) on delete set null,
  next_rule_id bigint references public.telegram_auto_reply_rules(id) on delete cascade,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (business_connection_id, chat_id)
);

create table if not exists public.telegram_review_queue (
  id uuid primary key default gen_random_uuid(),
  business_connection_id text not null,
  customer_chat_id bigint not null,
  customer_user_id bigint,
  customer_name text,
  source_message_id bigint,
  media_type text not null,
  telegram_file_id text,
  telegram_file_unique_id text,
  triggered_rule_id bigint references public.telegram_auto_reply_rules(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

alter table public.telegram_auto_reply_rules drop constraint if exists telegram_auto_reply_rules_match_type_check;
alter table public.telegram_auto_reply_rules add constraint telegram_auto_reply_rules_match_type_check
check (match_type in (
  'new_chat','exact','contains','starts_with','ends_with','default',
  'photo','video','pdf','document','voice','audio','any_media','flow_step'
));

alter table public.telegram_auto_reply_rules alter column reply_text drop not null;
alter table public.telegram_auto_reply_rules
  add column if not exists reply_type text not null default 'text',
  add column if not exists media_id uuid references public.telegram_media_library(id) on delete set null,
  add column if not exists next_rule_id bigint references public.telegram_auto_reply_rules(id) on delete set null,
  add column if not exists notify_admin boolean not null default false,
  add column if not exists approval_reply_text text,
  add column if not exists rejection_reply_text text;

alter table public.telegram_auto_reply_rules drop constraint if exists telegram_auto_reply_rules_reply_type_check;
alter table public.telegram_auto_reply_rules add constraint telegram_auto_reply_rules_reply_type_check
check (reply_type in ('text','voice','audio','photo','video','document'));

alter table public.telegram_reply_logs
  add column if not exists reply_type text,
  add column if not exists reply_media_id uuid references public.telegram_media_library(id) on delete set null;

alter table public.telegram_media_library enable row level security;
alter table public.telegram_pending_media_uploads enable row level security;
alter table public.telegram_conversation_states enable row level security;
alter table public.telegram_review_queue enable row level security;

revoke all on table public.telegram_media_library from anon, authenticated;
revoke all on table public.telegram_pending_media_uploads from anon, authenticated;
revoke all on table public.telegram_conversation_states from anon, authenticated;
revoke all on table public.telegram_review_queue from anon, authenticated;

grant select, insert, update, delete on table public.telegram_media_library to service_role;
grant select, insert, update, delete on table public.telegram_pending_media_uploads to service_role;
grant select, insert, update, delete on table public.telegram_conversation_states to service_role;
grant select, insert, update, delete on table public.telegram_review_queue to service_role;

create index if not exists telegram_media_library_type_idx on public.telegram_media_library (media_type, created_at desc);
create index if not exists telegram_review_queue_status_idx on public.telegram_review_queue (status, created_at desc);
create index if not exists telegram_conversation_states_next_idx on public.telegram_conversation_states (next_rule_id, updated_at desc);

insert into public.telegram_settings (key, value)
values ('flow_state_ttl_hours', '24'::jsonb)
on conflict (key) do nothing;