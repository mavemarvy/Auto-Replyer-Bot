alter table public.telegram_plans
  add column if not exists usd_price_cents integer,
  add column if not exists stars_price integer,
  add column if not exists max_media_items integer,
  add column if not exists features jsonb not null default '{}'::jsonb;

insert into public.telegram_plans(
  code,name,currency,monthly_price_minor,usd_price_cents,trial_days,is_active,
  max_media_items,features,updated_at
)
values
(
  'basic','Basic','NGN',100000,100,30,true,0,
  '{"text_replies":true,"new_chat":true,"exact":true,"contains":true,"starts_with":true,"ends_with":true,"default":true,"flows":false,"media_replies":false,"media_triggers":false,"media_verification":false}'::jsonb,
  now()
),
(
  'pro','Pro','NGN',200000,200,30,true,5,
  '{"text_replies":true,"new_chat":true,"exact":true,"contains":true,"starts_with":true,"ends_with":true,"default":true,"flows":true,"media_replies":true,"media_triggers":true,"media_verification":true}'::jsonb,
  now()
)
on conflict (code) do update set
  name=excluded.name,currency=excluded.currency,
  monthly_price_minor=excluded.monthly_price_minor,
  usd_price_cents=excluded.usd_price_cents,
  trial_days=excluded.trial_days,is_active=excluded.is_active,
  max_media_items=excluded.max_media_items,
  features=excluded.features,updated_at=now();

update public.telegram_tenants
set plan_code = case when is_platform_owner then 'pro' else coalesce(nullif(plan_code,'starter'),'basic') end,
    subscription_status = case when is_platform_owner then 'active' else subscription_status end,
    updated_at = now();

update public.telegram_subscriptions s
set plan_code = case
  when exists(select 1 from public.telegram_tenants t where t.id=s.tenant_id and t.is_platform_owner) then 'pro'
  else 'basic'
end,
status = case
  when exists(select 1 from public.telegram_tenants t where t.id=s.tenant_id and t.is_platform_owner) then 'active'
  else s.status
end,
updated_at=now();

create table if not exists public.telegram_referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_tenant_id uuid not null references public.telegram_tenants(id) on delete cascade,
  referred_tenant_id uuid not null unique references public.telegram_tenants(id) on delete cascade,
  referral_code text not null,
  status text not null default 'pending' check (status in ('pending','qualified','rejected')),
  qualified_at timestamptz,
  bonus_awarded boolean not null default false,
  created_at timestamptz not null default now(),
  check (referrer_tenant_id <> referred_tenant_id)
);

alter table public.telegram_tenants
  add column if not exists referral_code text,
  add column if not exists referral_bonus_seconds bigint not null default 0,
  add column if not exists referral_bonus_until timestamptz;

update public.telegram_tenants
set referral_code = upper(substr(replace(id::text,'-',''),1,10))
where referral_code is null;

create unique index if not exists telegram_tenants_referral_code_uq
  on public.telegram_tenants(referral_code);

alter table public.telegram_referrals enable row level security;
revoke all on table public.telegram_referrals from anon, authenticated;
grant select, insert, update, delete on table public.telegram_referrals to service_role;

insert into public.telegram_settings(key,value)
values
  ('billing_enforcement_enabled','true'::jsonb),
  ('referrals_per_bonus_hour','2'::jsonb),
  ('referral_bonus_seconds_per_reward','3600'::jsonb)
on conflict (key) do update set value=excluded.value;