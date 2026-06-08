# 30-Day Data Retention / Auto-Cleanup (Design Spec)

**Date:** 2026-06-08  **Status:** Approved (brainstorming)

## Context & goal
`CLAUDE.md` requires not persisting full chat logs beyond a short rolling window. Captured messages
accumulate in `inbox` (plus housekeeping tables). This adds an **automatic daily cleanup** that
deletes anything older than a configurable retention window (default **30 days**), while always
keeping `follow_ups` (the extracted value).

## Approved decisions
- **Schedule:** an app-side daily `node-cron` job in the **worker** process (cleanup is pure DB; it
  must not depend on the WhatsApp socket). Also runs **once at worker startup**.
- **Prune:** messages + housekeeping — `inbox`, `processed_messages`, `events`, and `sent` `outbox`
  rows older than the cutoff. **Keep all `follow_ups`.**

## Behavior
Cutoff = `now − RETENTION_DAYS × 86400` (unix seconds). Four deletes:
- `inbox` where `ts_unix < cutoff` (by message time)
- `processed_messages` where `seen_at < cutoff`
- `events` where `created_at < cutoff`
- `outbox` where `status = 'sent' AND sent_at < cutoff` (pending acks never purged)

`follow_ups` are never touched — and reminders survive even if their source `inbox` row is pruned,
because `follow_ups.context` already holds the one-line summary (no FK to `inbox`).

## Components / files
- **`src/db.ts`**: `purgeOlderThan(cutoffUnix): Promise<{inbox,processed,events,outbox}>` — the four
  DELETEs, returning per-table `rowCount`.
- **`src/cleanup.ts`** (new):
  - `runCleanup(retentionDays = config.RETENTION_DAYS, nowUnix = now): Promise<Counts>` — computes
    cutoff, calls `purgeOlderThan`, `logEvent('cleanup_ran', {...})`, logs counts. Pure/injectable.
  - `startCleanupCron()` — `node-cron` daily at `CLEANUP_HOUR` in `TIMEZONE`, each run wrapped in
    `.catch` so an error never crashes the process.
- **`src/worker.ts`**: in the direct-run guard, after `ensureSchema()`: `startCleanupCron()` and a
  one-off `void runCleanup().catch(...)` (startup sweep), then `runLoop()`.
- **`src/config.ts`** + `.env.example`: `RETENTION_DAYS` (`z.coerce.number().int().positive().default(30)`)
  and `CLEANUP_HOUR` (`z.coerce.number().int().min(0).max(23).default(3)`).

## Reuses
`logEvent`, `getPool` (db); the `import * as cron from 'node-cron'` + `{ timezone }` pattern from
`scheduler.ts`; the `config` zod schema; pg-mem test setup.

## Testing
pg-mem unit tests (`test/cleanup.test.ts`):
- seed old + recent rows in `inbox`/`processed_messages`/`events`/`outbox` and a `follow_up`;
  `runCleanup(30, fixedNow)` deletes only the old rows, keeps recent rows, **keeps the follow_up**,
  and returns the right counts.
- a `sent`-vs-unsent `outbox` case (unsent old row is NOT purged).

## Out of scope
pg_cron; pruning terminal `follow_ups`; per-contact "keep last N" retention (time-based only).

## Files
New: `src/cleanup.ts`, `test/cleanup.test.ts`. Modified: `src/db.ts`, `src/worker.ts`,
`src/config.ts`, `.env.example`.
