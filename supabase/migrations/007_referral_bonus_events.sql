create table if not exists public.telegram_referral_bonus_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.telegram_tenants(id) on delete cascade,
  seconds_added bigint not null,
  reason text not null,
  source_referral_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.telegram_referral_bonus_events enable row level security;
revoke all on table public.telegram_referral_bonus_events from anon, authenticated;
grant select, insert, update, delete on table public.telegram_referral_bonus_events to service_role;

create index if not exists telegram_referral_bonus_events_tenant_idx
  on public.telegram_referral_bonus_events(tenant_id,created_at desc);