# Auto Replyer Bot

Telegram Business auto-reply system for a personal Telegram account.

## Current architecture

- **Telegram Business Bot** receives personal DM events.
- **Supabase Edge Function** processes Telegram webhook updates 24/7.
- **Supabase Postgres** stores rules and remembers first-time chats.
- **GitHub** stores the source code and migration.
- **Vercel is not required** for the bot backend. It can be added later for a web admin dashboard.

## Supported rules

- `new_chat`
- `exact`
- `contains`
- `starts_with`
- `ends_with`
- `default`

Rules are evaluated by ascending `priority`, then `id`. The first matching rule wins.

## Supabase project

Project name: `Auto-Replyer-Bot`

Edge Function: `telegram-auto-reply`

The database migration is in:

`supabase/migrations/001_auto_reply.sql`

The Edge Function source is in:

`supabase/functions/telegram-auto-reply/index.ts`

## Required secrets

Add these as Supabase Edge Function secrets. Do not commit their values to GitHub.

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions.

## Telegram webhook

After the two Telegram secrets are configured, register the Edge Function URL as the Bot API webhook and subscribe to Business updates.

Use these update types:

- `business_connection`
- `business_message`
- `edited_business_message`
- `deleted_business_messages`

## Security

- Telegram webhook requests are validated with `X-Telegram-Bot-Api-Secret-Token`.
- Database tables have RLS enabled.
- `anon` and `authenticated` have no direct access to the bot tables.
- Service-role access is server-side only.
