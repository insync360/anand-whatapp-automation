# Project: WhatsApp Follow-up Assistant (single user, self-hosted)

## What it does
Listens to my WhatsApp 1:1 chats as a read-only linked device. When I or a
contact agree on a next point of contact ("let's connect Tuesday", "call me
after Diwali", "I'll revert next week"), an LLM extracts it, resolves it to a
real date, and reminds me on the day via a WhatsApp message to my own number.
The only WhatsApp message it sends is that reminder, to my own number.

## Hard constraints (never violate)
- WhatsApp is READ-ONLY for message capture. The ONLY permitted send is the daily
  reminder digest to MY OWN number (self-chat). Never message contacts; never use
  typing/reaction/receipt APIs.
- Reminders are delivered via WhatsApp self-message. Telegram is no longer used.
- Single user. No multi-tenant, no auth system, no web server unless asked.
- Treat chat content as sensitive: store only the extracted follow-up plus a
  one-line context. Do NOT persist full chat logs beyond a short rolling window
  needed for context. Keep secrets in .env (gitignored), never in code.

## Architecture (decoupled stages, Neon Postgres as the durable queue)
WhatsApp (phone, read-only link)
  -> Listener: normalize + dedup, INSERT each message into `inbox` table
  -> Extraction worker: poll `inbox` -> keyword prefilter -> Claude -> validate
     -> write `follow_ups`
  -> Scheduler: daily, find due follow-ups -> deliver via WhatsApp self-message
The `inbox` table IS the durable queue: if the worker or LLM is down, messages
wait safely and are processed on restart. Everything is idempotent.

## Tech stack
- Node.js 20+, TypeScript, run with `tsx` (no build step)
- WhatsApp: @whiskeysockets/baileys (multi-file auth state, QR login)
- DB + queue: Neon Postgres via pg (node-postgres), async
- LLM: @anthropic-ai/sdk. Model from env MODEL (default claude-haiku-4-5-20251001)
- Validation: zod (validate all LLM JSON output)
- Scheduling: node-cron
- Logging: pino
- Delivery: WhatsApp self-message via the listener's Baileys socket
- Config: dotenv, validated with zod at startup

## Data model (Neon Postgres)
- inbox(id, wa_message_id, chat_jid, contact_name, from_me, text, ts_unix,
        status['pending'|'done'|'error'], created_at)
- follow_ups(id, chat_jid, contact_name, due_date 'YYYY-MM-DD', due_time NULLABLE,
        context, source_wa_message_id, confidence REAL,
        status['pending'|'needs_review'|'confirmed'|'sent'|'done'|'cancelled'|'snoozed'],
        created_at, updated_at, sent_at NULLABLE)
- processed_messages(wa_message_id PRIMARY KEY, seen_at)
- events(id, type, payload_json, created_at)

## Conventions
- ESM. Small modules in `src/`. Each long-running role has its own entry script.
- Wrap external calls (Baileys, Anthropic, Telegram) in try/catch; never crash
  the process on a single bad message.
- Use the message timestamp + configured timezone to resolve relative dates.