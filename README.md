# Auto Replyer Bot

Telegram Business auto-reply system for a personal Telegram account.

## Live dashboard

Production dashboard:

https://auto-replyer-bot.vercel.app

The dashboard is protected by the value of `TELEGRAM_WEBHOOK_SECRET`. The browser keeps it in session storage only.

## Architecture

- **Telegram Business Bot** receives personal DM events.
- **Supabase Edge Function** processes Telegram webhook updates 24/7.
- **Supabase Postgres** stores rules, settings, first-time chats, and reply logs.
- **Vercel** hosts the control panel.
- **GitHub** stores the source code and migrations.

## Supported rule types

- `new_chat`
- `exact`
- `contains`
- `starts_with`
- `ends_with`
- `default`

Rules are evaluated by ascending `priority`, then `id`. The first matching rule wins.

## Dashboard features

- Global Auto Reply ON/OFF
- Add, edit, enable, disable, and delete rules
- New messenger greeting
- Exact and keyword matching
- Telegram webhook status
- Bot Business-mode capability status
- Seen-person count
- Recent auto-reply history
- Reset new-chat memory
- Secure Register/Re-register Webhook action

## Supabase project

Project name: `Auto-Replyer-Bot`

Edge Function: `telegram-auto-reply`

Webhook URL:

`https://iqdttxdowvdxszxbiwua.supabase.co/functions/v1/telegram-auto-reply`

## Required Supabase secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

Never commit their values to GitHub.

## Security

- Telegram webhook calls are validated with a derived SHA-256 secret token.
- Dashboard administration requires the raw `TELEGRAM_WEBHOOK_SECRET`.
- Database tables have RLS enabled.
- `anon` and `authenticated` have no direct access to bot tables.
- Service-role access stays server-side inside the Edge Function.
- The temporary public webhook-registration route used during initial setup has been removed.
