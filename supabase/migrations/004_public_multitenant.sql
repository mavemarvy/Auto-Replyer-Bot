create extension if not exists pgcrypto;

create table if not exists public.telegram_tenants (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  display_name text,
  username text,
  pin_hash text,
  trial_started_at timestamptz not null default now(),
  trial_ends_at timestamptz not null default (now() + interval '30 days'),
  subscription_status text not null default 'trial'
    check (subscription_status in ('trial','active','past_due','canceled','suspended')),
  plan_code text not null default 'starter',
  is_platform_owner boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_business_connections (
  business_connection_id text primary key,
  tenant_id uuid not null references public.telegram_tenants(id) on delete cascade,
  telegram_user_id bigint not null,
  is_enabled boolean not null default true,
  rights jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_tenant_settings (
  tenant_id uuid not null references public.telegram_tenants(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

create table if not exists public.telegram_plans (
  code text primary key,
  name text not null,
  currency text not null default 'NGN',
  monthly_price_minor bigint not null default 0,
  trial_days integer not null default 30,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_subscriptions (
  tenant_id uuid primary key references public.telegram_tenants(id) on delete cascade,
  plan_code text not null references public.telegram_plans(code),
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  status text not null default 'trial'
    check (status in ('trial','active','past_due','canceled','suspended')),
  trial_end timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.telegram_plans(code,name,currency,monthly_price_minor,trial_days,is_active)
values ('starter','Starter','NGN',100000,30,false)
on conflict (code) do update
set name=excluded.name,currency=excluded.currency,
    monthly_price_minor=excluded.monthly_price_minor,trial_days=excluded.trial_days;

insert into public.telegram_settings(key,value)
values ('billing_enforcement_enabled','false'::jsonb)
on conflict (key) do nothing;

alter table public.telegram_auto_reply_rules add column if not exists tenant_id uuid references public.telegram_tenants(id) on delete cascade;
alter table public.telegram_seen_chats add column if not exists tenant_id uuid references public.telegram_tenants(id) on delete cascade;
alter table public.telegram_reply_logs add column if not exists tenant_id uuid references public.telegram_tenants(id) on delete cascade;
alter table public.telegram_media_library add column if not exists tenant_id uuid references public.telegram_tenants(id) on delete cascade;
alter table public.telegram_pending_media_uploads add column if not exists tenant_id uuid references public.telegram_tenants(id) on delete cascade;
alter table public.telegram_conversation_states add column if not exists tenant_id uuid references public.telegram_tenants(id) on delete cascade;
alter table public.telegram_review_queue add column if not exists tenant_id uuid references public.telegram_tenants(id) on delete cascade;
alter table public.telegram_review_expectations add column if not exists tenant_id uuid references public.telegram_tenants(id) on delete cascade;

alter table public.telegram_tenants enable row level security;
alter table public.telegram_business_connections enable row level security;
alter table public.telegram_tenant_settings enable row level security;
alter table public.telegram_plans enable row level security;
alter table public.telegram_subscriptions enable row level security;

revoke all on table public.telegram_tenants from anon, authenticated;
revoke all on table public.telegram_business_connections from anon, authenticated;
revoke all on table public.telegram_tenant_settings from anon, authenticated;
revoke all on table public.telegram_plans from anon, authenticated;
revoke all on table public.telegram_subscriptions from anon, authenticated;

grant select, insert, update, delete on table public.telegram_tenants to service_role;
grant select, insert, update, delete on table public.telegram_business_connections to service_role;
grant select, insert, update, delete on table public.telegram_tenant_settings to service_role;
grant select, insert, update, delete on table public.telegram_plans to service_role;
grant select, insert, update, delete on table public.telegram_subscriptions to service_role;
