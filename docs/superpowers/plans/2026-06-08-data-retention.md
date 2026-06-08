# 30-Day Data Retention — Implementation Plan

> Spec: `docs/superpowers/specs/2026-06-08-data-retention-design.md`. TDD per task.

**Goal:** Daily auto-delete of `inbox` + housekeeping rows older than `RETENTION_DAYS` (default 30),
run by a cron in the worker; `follow_ups` always kept.

---

## Task 1: config + `purgeOlderThan` + `cleanup.ts` (TDD)
**Files:** `src/config.ts`, `.env.example`, `src/db.ts`, `src/cleanup.ts` (new), `test/cleanup.test.ts` (new).

- [ ] **config.ts**: add after `OUTBOX_POLL_MS`:
```ts
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  CLEANUP_HOUR: z.coerce.number().int().min(0).max(23).default(3),
```
- [ ] **.env.example**: append `RETENTION_DAYS=30` and `CLEANUP_HOUR=3`.
- [ ] **db.ts**: add
```ts
export async function purgeOlderThan(cutoffUnix: number): Promise<{ inbox: number; processed: number; events: number; outbox: number }> {
  const pool = getPool();
  const inbox = (await pool.query(`DELETE FROM inbox WHERE ts_unix < $1`, [cutoffUnix])).rowCount ?? 0;
  const processed = (await pool.query(`DELETE FROM processed_messages WHERE seen_at < $1`, [cutoffUnix])).rowCount ?? 0;
  const events = (await pool.query(`DELETE FROM events WHERE created_at < $1`, [cutoffUnix])).rowCount ?? 0;
  const outbox = (await pool.query(`DELETE FROM outbox WHERE status='sent' AND sent_at < $1`, [cutoffUnix])).rowCount ?? 0;
  return { inbox, processed, events, outbox };
}
```
- [ ] **src/cleanup.ts**:
```ts
import * as cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { purgeOlderThan, logEvent } from './db.js';

export async function runCleanup(
  retentionDays = config.RETENTION_DAYS,
  nowUnix = Math.floor(Date.now() / 1000),
): Promise<{ inbox: number; processed: number; events: number; outbox: number }> {
  const cutoff = nowUnix - retentionDays * 86_400;
  const counts = await purgeOlderThan(cutoff);
  await logEvent('cleanup_ran', { retentionDays, cutoff, ...counts });
  logger.info({ retentionDays, ...counts }, 'data retention cleanup ran');
  return counts;
}

export function startCleanupCron(): void {
  const expr = `0 ${config.CLEANUP_HOUR} * * *`;
  cron.schedule(
    expr,
    () => { void runCleanup().catch((err) => logger.error({ err }, 'cleanup failed')); },
    { timezone: config.TIMEZONE },
  );
  logger.info({ cron: expr, tz: config.TIMEZONE, retentionDays: config.RETENTION_DAYS }, 'cleanup scheduler started');
}
```
- [ ] **test/cleanup.test.ts** (pg-mem):
```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ensureSchema, getPool, insertInboxMessage, insertFollowUp, enqueueOutbox, markProcessed, logEvent } from '../src/db.js';
import { runCleanup } from '../src/cleanup.js';

const NOW = 2_000_000_000;             // fixed "now" (unix seconds)
const OLD = NOW - 40 * 86_400;         // 40 days ago
const RECENT = NOW - 5 * 86_400;       // 5 days ago

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => {
  for (const t of ['inbox', 'follow_ups', 'processed_messages', 'events', 'outbox']) {
    await getPool().query(`DELETE FROM ${t}`);
  }
});

describe('runCleanup', () => {
  it('deletes rows older than retention, keeps recent rows and all follow_ups', async () => {
    // inbox: one old, one recent (ts_unix drives age)
    await insertInboxMessage({ wa_message_id: 'old', chat_jid: 'c', from_me: false, text: 'old', ts_unix: OLD });
    await insertInboxMessage({ wa_message_id: 'new', chat_jid: 'c', from_me: false, text: 'new', ts_unix: RECENT });
    // processed_messages + events + outbox use created/seen/sent timestamps = now() at insert (recent),
    // so to test old ones we set timestamps directly:
    await getPool().query(`INSERT INTO processed_messages (wa_message_id, seen_at) VALUES ('p_old',$1),('p_new',$2)`, [OLD, RECENT]);
    await getPool().query(`INSERT INTO events (type, payload_json, created_at) VALUES ('e_old',null,$1),('e_new',null,$2)`, [OLD, RECENT]);
    await getPool().query(`INSERT INTO outbox (text,status,created_at,sent_at) VALUES ('o_old_sent','sent',$1,$1),('o_old_pending','pending',$1,null),('o_new_sent','sent',$2,$2)`, [OLD, RECENT]);
    // a follow_up that must survive
    await insertFollowUp({ chat_jid: 'c', due_date: '2020-01-01', context: 'keep me' });

    const counts = await runCleanup(30, NOW);
    expect(counts).toEqual({ inbox: 1, processed: 1, events: 1, outbox: 1 }); // only the old sent outbox

    expect((await getPool().query(`SELECT wa_message_id FROM inbox`)).rows.map((r) => r.wa_message_id)).toEqual(['new']);
    expect((await getPool().query(`SELECT count(*)::int c FROM processed_messages`)).rows[0].c).toBe(1);
    expect((await getPool().query(`SELECT count(*)::int c FROM events WHERE type LIKE 'e_%'`)).rows[0].c).toBe(1);
    // outbox: old sent gone; old PENDING kept; new sent kept => 2 remain
    expect((await getPool().query(`SELECT count(*)::int c FROM outbox`)).rows[0].c).toBe(2);
    // follow_up untouched
    expect((await getPool().query(`SELECT count(*)::int c FROM follow_ups`)).rows[0].c).toBe(1);
  });
});
```
- [ ] Run `npx vitest run test/cleanup.test.ts` → FAIL then PASS. Full `npx vitest run` green; `tsc` 0.
- [ ] Commit `feat: add 30-day data retention purge (db.purgeOlderThan + cleanup.runCleanup + cron)`.

## Task 2: wire the cron into the worker
**Files:** `src/worker.ts`.
- [ ] Import `startCleanupCron, runCleanup` from `./cleanup.js`. In the direct-run guard, change the
  `ensureSchema().then(() => runLoop())` chain to also start cleanup:
```ts
  void ensureSchema()
    .then(() => {
      startCleanupCron();
      void runCleanup().catch((err) => logger.error({ err }, 'startup cleanup failed'));
      return runLoop();
    })
    .catch((err) => { logger.error({ err }, 'failed to start worker'); process.exit(1); });
```
- [ ] Full `npx vitest run` green; `npx tsc --noEmit` → 0. Commit `feat: run data-retention cleanup from the worker (cron + startup sweep)`.

## Verification
- `npx vitest run` green; `tsc` clean.
- After deploy: worker log shows `cleanup scheduler started` + `data retention cleanup ran` with counts;
  MCP `SELECT count(*) FROM inbox` shows only ≤30-day-old rows; `follow_ups` unchanged.
