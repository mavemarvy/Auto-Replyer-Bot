create table if not exists public.telegram_review_expectations (
  business_connection_id text not null,
  chat_id bigint not null,
  source_rule_id bigint not null references public.telegram_auto_reply_rules(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (business_connection_id, chat_id)
);

alter table public.telegram_review_expectations enable row level security;
revoke all on table public.telegram_review_expectations from anon, authenticated;
grant select, insert, update, delete on table public.telegram_review_expectations to service_role;

create index if not exists telegram_review_expectations_expires_idx
  on public.telegram_review_expectations (expires_at);