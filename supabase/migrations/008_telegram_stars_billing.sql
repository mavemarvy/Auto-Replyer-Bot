alter table public.telegram_subscriptions
  add column if not exists telegram_payment_charge_id text,
  add column if not exists auto_renew_enabled boolean not null default true,
  add column if not exists canceled_at timestamptz;

create table if not exists public.telegram_payment_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.telegram_tenants(id) on delete cascade,
  plan_code text not null references public.telegram_plans(code),
  provider text not null default 'telegram_stars',
  currency text not null default 'XTR',
  amount integer not null,
  invoice_payload text not null unique,
  status text not null default 'pending'
    check (status in ('pending','approved','paid','expired','canceled','failed')),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_star_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.telegram_tenants(id) on delete cascade,
  intent_id uuid references public.telegram_payment_intents(id) on delete set null,
  plan_code text not null references public.telegram_plans(code),
  invoice_payload text not null,
  telegram_payment_charge_id text not null unique,
  provider_payment_charge_id text,
  currency text not null default 'XTR',
  amount integer not null,
  is_recurring boolean not null default false,
  is_first_recurring boolean not null default false,
  subscription_expiration_date timestamptz,
  raw_payment jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.telegram_support_tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.telegram_tenants(id) on delete cascade,
  category text not null default 'general' check (category in ('general','payment')),
  message text not null,
  status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now()
);

alter table public.telegram_payment_intents enable row level security;
alter table public.telegram_star_payments enable row level security;
alter table public.telegram_support_tickets enable row level security;

revoke all on table public.telegram_payment_intents from anon, authenticated;
revoke all on table public.telegram_star_payments from anon, authenticated;
revoke all on table public.telegram_support_tickets from anon, authenticated;

grant select, insert, update, delete on table public.telegram_payment_intents to service_role;
grant select, insert, update, delete on table public.telegram_star_payments to service_role;
grant select, insert, update, delete on table public.telegram_support_tickets to service_role;