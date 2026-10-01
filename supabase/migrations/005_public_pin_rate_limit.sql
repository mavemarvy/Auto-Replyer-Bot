create table if not exists public.telegram_auth_security (
  tenant_id uuid primary key references public.telegram_tenants(id) on delete cascade,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_failed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.telegram_auth_security enable row level security;
revoke all on table public.telegram_auth_security from anon, authenticated;
grant select, insert, update, delete on table public.telegram_auth_security to service_role;