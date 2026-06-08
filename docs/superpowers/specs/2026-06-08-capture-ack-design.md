# Capture Acknowledgment (Design Spec)

**Date:** 2026-06-08  **Status:** Approved (brainstorming)

## Context & goal
Today a captured follow-up is silent until the daily 08:00 digest. This feature sends an
**immediate WhatsApp acknowledgment to my own number** the moment the extraction worker records a
follow-up — e.g. after a client (Ajeet) says "I'll get back to you Tuesday next week", I get a
formatted "✅ Follow-up recorded — Ajeet, next Tuesday…" message confirming it's in the system.

## Approved decisions
- **Delivery via a new `outbox` table** (worker enqueues; the listener, which holds the socket,
  polls + sends). Mirrors the `inbox`-as-queue pattern; no dual-session conflict.
- **Ack every newly recorded follow-up, with wording by confidence:** `pending` (≥0.6) → "recorded";
  `needs_review` (<0.6) → softer "possible follow-up — saved for review".
- **Structured-card format** (WhatsApp markdown).
- Out of scope (future): replying yes/no to confirm/cancel a `needs_review` item (no reply-handler).

## Data flow
```
worker.processRow inserts a follow_up
   └─► enqueueOutbox(buildAck(...))            -> outbox(status 'pending')
listener (live socket), every ~5s while connected
   └─► drainOutbox: getPendingOutbox → makeDeliver(liveSock, selfJid) → markOutboxSent
```

## Components / files
- **`src/ack.ts`** (new, pure): 
  - `relativeDay(today, dueDate): string` — `today | tomorrow | this <Weekday> | next <Weekday> |
    in N days`, using Monday-start week math (days 0/1 override to today/tomorrow).
  - `buildAck({ userName, contactName, dueDate, dueTime, context, today, status }): string` —
    formats the card; header + greeting differ for `pending` vs `needs_review`; date shown as
    `Tue, 16 Jun 2026` (Intl en-GB, UTC) + ` (relative)`; adds ` at *HH:MM*` when `dueTime` set;
    `contactName ?? 'your contact'`.
- **`src/db.ts`**: add to `ensureSchema`:
  `outbox(id SERIAL PK, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
   CHECK (status IN ('pending','sent')), created_at BIGINT NOT NULL, sent_at BIGINT)` +
  `idx_outbox_status (status, id)`. Helpers: `enqueueOutbox(text): Promise<number>`,
  `getPendingOutbox(limit=20): Promise<OutboxRow[]>`, `markOutboxSent(id): Promise<void>`; type `OutboxRow`.
- **`src/outbox.ts`** (new): `drainOutbox({ getPending, markSent, deliver }): Promise<number>` —
  for each pending row: `deliver(text)` then `markSent(id)`; returns count.
- **`src/worker.ts`**: in `processRow`, on the branch where a follow-up is actually inserted (NOT the
  duplicate-skip branch), after `logEvent`, `await enqueueOutbox(buildAck({ userName: config.USER_NAME,
  contactName: row.contact_name, dueDate: result.date, dueTime: result.time, context: result.context,
  today: todayInTz(config.TIMEZONE), status }))`.
- **`src/listener.ts`**: on connect (once), `setInterval(~5000)` that **skips when `!liveSock`** and
  otherwise runs `drainOutbox` with `makeDeliver(liveSock, liveSelfJid)`. Reuses the self-send +
  echo-`markProcessed` (no feedback loop). Guard with an `outboxStarted` flag like the scheduler.
- **`src/config.ts`**: add `USER_NAME` (default `'Anand'`). `.env.example`: `USER_NAME=Anand`.

## Message templates (WhatsApp markdown; `*x*` = bold)
**pending**
```
✅ *Follow-up recorded*

Hi {USER_NAME} 👋
👤 Contact: *{contact}*
📅 Due: *{Tue, 16 Jun 2026}*{ at *16:00*}{ (next Tuesday)}
📝 {context}
```
**needs_review**
```
🤔 *Possible follow-up — saved for review*

Hi {USER_NAME} 👋 I wasn't fully sure, but it sounded like:
👤 Contact: *{contact}*
📅 Due: *{Tue, 16 Jun 2026}*{ at *16:00*}{ (next Tuesday)}
📝 {context}
```

## Edge cases
- Feedback loop: ack is `from_me`; `makeDeliver` markProcesses the echo → listener dedup skips it.
- One ack per follow-up: enqueued only when a new row is inserted (dedup-skip path does not enqueue).
- Offline: poller skips while `liveSock` is undefined → acks stay `pending`, flush on reconnect (this
  is why the poller must NOT drain through a console-only `makeDeliver(undefined)`, which would mark
  rows sent without delivering).
- Known tradeoff: `makeDeliver` never throws, so a silent send failure still marks `sent` (same as
  the reminder path; acceptable single-user).

## Testing
- Pure TDD: `relativeDay` (today/tomorrow/this-/next-weekday/in-N-days) and `buildAck` (both templates,
  with/without time, null contact).
- pg-mem: outbox helpers (enqueue → getPending → markSent) and `drainOutbox` (fakes).
- Manual e2e: send yourself a scheduling message → worker records it → ack arrives on WhatsApp.

## Files summary
New: `src/ack.ts`, `src/outbox.ts`, tests `test/ack.test.ts`, `test/outbox.test.ts`.
Modified: `src/db.ts`, `src/worker.ts`, `src/listener.ts`, `src/config.ts`, `.env.example`.
Provisioning: create the `outbox` table in Neon via MCP.
