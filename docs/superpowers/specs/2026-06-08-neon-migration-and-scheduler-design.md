# Phase 4 — Neon Migration + Scheduler/Delivery (Design Spec)

**Date:** 2026-06-08
**Status:** Approved (brainstorming)

## Context & why
Phases 1–3 deliver: SQLite scaffold + read-only WhatsApp listener → `inbox` queue → LLM extraction
worker → `follow_ups`. Nothing yet fires a reminder. Phase 4 closes the loop, with two
user-directed changes that override original `CLAUDE.md` constraints:

1. **Persistence moves SQLite → Neon Postgres** (project `anand whatsaapp automation`,
   id `square-mud-98135286`, pg18). Reason: user wants a managed/remote DB.
2. **Reminders deliver via WhatsApp self-message, not Telegram.** The reminder is sent to the
   user's own number (self-chat) using the existing linked Baileys session. This **reverses** the
   "WhatsApp strictly read-only / Telegram-only" hard rule — done deliberately, with eyes open to
   the modest account-ban risk and the loss of the read-only guarantee.

Built and tested in order: **4a (Neon migration)** first, then **4b (scheduler + delivery)**.

## Non-negotiable updates to CLAUDE.md (part of 4b)
- WhatsApp send is now permitted **only** for delivering reminders to the user's OWN number.
  No sending to contacts, no typing/reactions.
- Delivery channel = WhatsApp self-chat. Telegram is retired (env vars may remain unused).
- Durable store = Neon Postgres (not SQLite).

---

## Phase 4a — Data layer: better-sqlite3 → pg (Neon)

**Driver:** `pg` (node-postgres) for long-running processes. Register an int8→Number type parser
so `BIGINT` epoch columns and `SERIAL` ids return as JS numbers.

**Config:** add `DATABASE_URL` (required, zod) — pooled Neon connection string, fetched via Neon
MCP `get_connection_string`, stored in `.env` (gitignored). Retire `DB_PATH`.

**Schema** (created in Neon via MCP, AND idempotently via `ensureSchema()` at startup) — same 4
tables/semantics as `CLAUDE.md`, Postgres types:
- `inbox(id SERIAL PK, wa_message_id TEXT NOT NULL, chat_jid TEXT NOT NULL, contact_name TEXT,
  from_me BOOLEAN NOT NULL DEFAULT false, text TEXT NOT NULL, ts_unix BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','error')),
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint)`,
  `UNIQUE INDEX (wa_message_id)`, plus the status and chat indexes.
- `follow_ups(...)` with `confidence DOUBLE PRECISION`, `due_date TEXT`, `due_time TEXT`, the
  7-value status CHECK, `created_at/updated_at BIGINT`, `sent_at BIGINT NULL`.
- `processed_messages(wa_message_id TEXT PRIMARY KEY, seen_at BIGINT DEFAULT …)`.
- `events(id SERIAL PK, type TEXT NOT NULL, payload_json TEXT, created_at BIGINT DEFAULT …)`.

**`db.ts` rewrite:** module-level `pg.Pool` from `config.DATABASE_URL`, but the pool is
**injectable** for tests (`__setPoolForTests(pool)` / lazy `getPool()`). All helpers become async:
- `insertInboxMessage` → `INSERT … ON CONFLICT (wa_message_id) DO NOTHING RETURNING id` (returns
  id or existing id via a follow-up select), `getPendingInbox`, `getRecentMessagesForChat`,
  `markInboxDone`, `hasProcessed`, `markProcessed` (`ON CONFLICT DO NOTHING`), `insertFollowUp`
  (`RETURNING id`), `getDueFollowUps`, `updateFollowUpStatus`, `logEvent`, plus
  `hasActiveFollowUp` (moves here or stays in worker). Signatures unchanged except `Promise<…>`.
- `InboxRow.from_me` becomes `boolean`. `ensureSchema()` exported and awaited by entrypoints.

**Callers updated to await:** `listener.ts` (`handleMessage` async; `messages.upsert` awaits each
message in order), `worker.ts` (`processRow`/`hasActiveFollowUp` await), `index.ts`
(`await ensureSchema()`), `scripts/seed-inbox.ts` (await inserts).

**Tests:** DB-backed tests (`worker.test.ts`) run against **`pg-mem`** (in-memory Postgres) via an
injected pool in `test/setup.ts`; truncate tables in `beforeEach`. `extractor.test.ts` unchanged.
Fallback: any statement `pg-mem` can't handle → that test uses a Neon test branch.

**Verify 4a:** `npm run seed` then `npm run start:worker` write to Neon; confirm rows via MCP
`run_sql`. Existing pipeline behavior unchanged.

---

## Phase 4b — Scheduler + WhatsApp self-delivery

**`src/notify.ts`** — `deliver(text, sock?, selfJid?)`: always `console.log(text)`; if a live `sock`
+ `selfJid` are provided, `await sock.sendMessage(selfJid, { text })` and `markProcessed` the
returned message id (see feedback-loop fix). Entire body in try/catch; **never throws**.

**`src/scheduler.ts`**
- `runReminders(deps)` — pure orchestration, unit-testable with fakes. `deps`:
  `{ today: string, getDue(today), markSent(id), deliver(text), logEvent }`. Fetches due
  follow-ups (status ∈ `pending`,`confirmed`; `due_date <= today`), sorts by `due_date` then
  `due_time` (nulls last), builds digest:
  `📌 Follow-ups for <today> (N):` then per item
  `• <contact> <time?> — <context>` with ` (was due <due_date>)` appended when `due_date < today`.
  Delivers once; on success flips each row to `sent`, sets `sent_at`, `logEvent('reminder_sent')`.
  Nothing due → log, deliver nothing.
- `startScheduler(deliver)` — `node-cron` at minute 0 of `REMINDER_HOUR` in `TIMEZONE`.

**Delivery location:** runs **inside the listener process**. On `connection==='open'`, listener
computes `selfJid = jidNormalizedUser(sock.user.id)` and calls `startScheduler` with a deliver
bound to `(sock, selfJid)`. `npm run start:listener` thus also schedules + delivers.

**`remind:now` script:** one-shot — connect Baileys with existing `AUTH_DIR`, wait for `open`, run
`runReminders` once with WhatsApp delivery, exit. ⚠️ Run only while the listener is stopped (single
session). Satisfies the "Done when".

**Feedback-loop fix:** a sent reminder is `from_me` and would be re-ingested. On send we get the
new message id and immediately `markProcessed(id)`, so the listener's existing `hasProcessed`
dedup skips the echo. Real `from_me` plans are unaffected.

**Verify 4b:** seed a follow-up due today → `npm run remind:now` posts the digest to the user's
WhatsApp self-chat and flips those rows to `sent` (verify via MCP `run_sql`).

---

## Testing strategy (whole phase)
- Pure-logic TDD (no DB/socket): digest building, overdue annotation, due-selection ordering,
  date-in-TIMEZONE computation, `selfJid` normalization helper.
- DB layer: `pg-mem` injected pool.
- End-to-end: manual via `seed` + `remind:now` against real Neon + real WhatsApp.

## Files
- 4a: `src/db.ts` (rewrite), `src/config.ts`, `src/listener.ts`, `src/worker.ts`, `src/index.ts`,
  `scripts/seed-inbox.ts`, `test/setup.ts`, `test/worker.test.ts`, `package.json` (deps: `pg`,
  `@types/pg`, `pg-mem`; scripts).
- 4b: `src/notify.ts` (new), `src/scheduler.ts` (new), `src/listener.ts` (start scheduler),
  `package.json` (`start:scheduler`/`remind:now`), `CLAUDE.md` (constraint rewrite),
  tests `test/scheduler.test.ts`, `test/notify.test.ts`.
