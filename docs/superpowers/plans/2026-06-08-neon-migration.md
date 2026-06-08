# Phase 4a — Migrate Data Layer to Neon Postgres (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (TDD per task).
> Steps use checkbox (`- [ ]`) syntax. Design spec:
> `docs/superpowers/specs/2026-06-08-neon-migration-and-scheduler-design.md`.

**Goal:** Replace synchronous better-sqlite3 with async `pg` (node-postgres) backed by the Neon
project `anand whatsaapp automation` (`square-mud-98135286`), keeping all helper semantics and the
4-table model identical. Scheduler/delivery (4b) is a SEPARATE later phase.

**Architecture:** `db.ts` owns an injectable `pg.Pool` + `ensureSchema()`; every helper becomes
`async`. App code sets epoch timestamps explicitly (no Postgres-specific default funcs) so the same
SQL runs under `pg-mem` in tests and real Neon in prod. Callers (`listener`, `worker`, `index`,
`seed`) gain `await`.

**Tech Stack:** Node 20+/TS/tsx, `pg`, `pg-mem` (tests), `zod`, `vitest`, Neon MCP.

> **Approved decisions:** WhatsApp self-delivery (4b) and Neon-first sequencing. This plan is 4a only.
> Timestamps are app-provided unix seconds (pg-mem-safe). `from_me` becomes BOOLEAN.

---

## Task 1: Deps, config, injectable pool + ensureSchema (TDD)

**Files:** Modify `package.json`, `src/config.ts`, `test/setup.ts`. Rewrite `src/db.ts` (pool+schema only this task). Create `test/db.test.ts`.

- [ ] **Step 1: Add deps + scripts.** `npm i pg` and `npm i -D @types/pg pg-mem`. (Leave better-sqlite3 installed; it's simply unused after this phase.)

- [ ] **Step 2: config — swap DB_PATH for DATABASE_URL.** In `src/config.ts` schema, remove `DB_PATH`, add:
```ts
DATABASE_URL: z.string().url('DATABASE_URL must be a valid Postgres connection string'),
```
Keep everything else. (`.env.example`: replace `DB_PATH=...` line with `DATABASE_URL=`.)

- [ ] **Step 3: test/setup.ts — inject a pg-mem pool.** Replace the DB_PATH line; wire pg-mem so `db.ts` uses an in-memory Postgres:
```ts
import { newDb } from 'pg-mem';
process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.DATABASE_URL ??= 'postgres://test/test';
process.env.TIMEZONE ??= 'Asia/Kolkata';
process.env.LOG_LEVEL ??= 'silent';

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const { __setPoolForTests } = await import('../src/db.js');
__setPoolForTests(new Pool());
```
(`vitest.config.ts` already uses this setup file; top-level await is fine in ESM.)

- [ ] **Step 4: Write failing test `test/db.test.ts`.**
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureSchema, getPool } from '../src/db.js';

describe('ensureSchema', () => {
  beforeAll(async () => { await ensureSchema(); });
  it('creates the four tables', async () => {
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
    );
    const names = rows.map((r: any) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(['events', 'follow_ups', 'inbox', 'processed_messages']));
  });
});
```

- [ ] **Step 5: Run `npx vitest run test/db.test.ts` → FAIL** (no `ensureSchema`/`getPool` yet).

- [ ] **Step 6: Implement pool + ensureSchema in `src/db.ts`** (top of the rewritten file):
```ts
import pg from 'pg';
import { config } from './config.js';

// int8 (BIGINT) → JS number; our magnitudes (unix seconds, ids) are well within Number range.
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

let pool: pg.Pool | undefined;
export function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  return pool;
}
/** Test seam: inject a pg-mem (or other) pool. */
export function __setPoolForTests(p: pg.Pool): void { pool = p; }

export async function ensureSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS inbox (
      id SERIAL PRIMARY KEY,
      wa_message_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      contact_name TEXT,
      from_me BOOLEAN NOT NULL DEFAULT false,
      text TEXT NOT NULL,
      ts_unix BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','error')),
      created_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_wa_message_id ON inbox (wa_message_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox (status, id);
    CREATE INDEX IF NOT EXISTS idx_inbox_chat ON inbox (chat_jid, ts_unix);

    CREATE TABLE IF NOT EXISTS follow_ups (
      id SERIAL PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      contact_name TEXT,
      due_date TEXT NOT NULL,
      due_time TEXT,
      context TEXT NOT NULL,
      source_wa_message_id TEXT,
      confidence DOUBLE PRECISION,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','needs_review','confirmed','sent','done','cancelled','snoozed')),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      sent_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups (due_date, status);

    CREATE TABLE IF NOT EXISTS processed_messages (
      wa_message_id TEXT PRIMARY KEY,
      seen_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT,
      created_at BIGINT NOT NULL
    );
  `);
}
```

- [ ] **Step 7: Run `npx vitest run test/db.test.ts` → PASS.** Then `npx tsc --noEmit` → exit 0.

- [ ] **Step 8: Commit** `feat: add pg pool + ensureSchema (Neon migration scaffolding)`.

---

## Task 2: Port all db helpers to async pg (TDD)

**Files:** Append to `src/db.ts`. Rewrite `test/worker.test.ts` for async + pg-mem.

- [ ] **Step 1: Implement types + async helpers in `src/db.ts`.** `now()` helper = `Math.floor(Date.now()/1000)`; pass timestamps explicitly.
```ts
const now = () => Math.floor(Date.now() / 1000);

export type InboxStatus = 'pending' | 'done' | 'error';
export type FollowUpStatus = 'pending'|'needs_review'|'confirmed'|'sent'|'done'|'cancelled'|'snoozed';

export interface InboxRow {
  id: number; wa_message_id: string; chat_jid: string; contact_name: string | null;
  from_me: boolean; text: string; ts_unix: number; status: InboxStatus; created_at: number;
}
export interface NewInboxMessage {
  wa_message_id: string; chat_jid: string; contact_name?: string | null;
  from_me: boolean; text: string; ts_unix: number;
}
export interface FollowUpRow {
  id: number; chat_jid: string; contact_name: string | null; due_date: string; due_time: string | null;
  context: string; source_wa_message_id: string | null; confidence: number | null;
  status: FollowUpStatus; created_at: number; updated_at: number; sent_at: number | null;
}
export interface NewFollowUp {
  chat_jid: string; contact_name?: string | null; due_date: string; due_time?: string | null;
  context: string; source_wa_message_id?: string | null; confidence?: number | null; status?: FollowUpStatus;
}

export async function insertInboxMessage(m: NewInboxMessage): Promise<number> {
  const ins = await getPool().query(
    `INSERT INTO inbox (wa_message_id, chat_jid, contact_name, from_me, text, ts_unix, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`,
    [m.wa_message_id, m.chat_jid, m.contact_name ?? null, m.from_me, m.text, m.ts_unix, now()],
  );
  if (ins.rows[0]) return ins.rows[0].id as number;
  const ex = await getPool().query(`SELECT id FROM inbox WHERE wa_message_id = $1`, [m.wa_message_id]);
  return (ex.rows[0]?.id as number) ?? 0;
}

export async function getPendingInbox(limit = 50): Promise<InboxRow[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM inbox WHERE status='pending' ORDER BY id ASC LIMIT $1`, [limit]);
  return rows as InboxRow[];
}

export async function markInboxDone(id: number, status: InboxStatus = 'done'): Promise<void> {
  await getPool().query(`UPDATE inbox SET status=$1 WHERE id=$2`, [status, id]);
}

export async function hasProcessed(waMessageId: string): Promise<boolean> {
  const { rows } = await getPool().query(`SELECT 1 FROM processed_messages WHERE wa_message_id=$1`, [waMessageId]);
  return rows.length > 0;
}

export async function markProcessed(waMessageId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO processed_messages (wa_message_id, seen_at) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [waMessageId, now()]);
}

export async function getRecentMessagesForChat(chatJid: string, limit = 20): Promise<InboxRow[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM inbox WHERE chat_jid=$1 ORDER BY ts_unix DESC, id DESC LIMIT $2`, [chatJid, limit]);
  return (rows as InboxRow[]).reverse();
}

export async function insertFollowUp(fu: NewFollowUp): Promise<number> {
  const t = now();
  const { rows } = await getPool().query(
    `INSERT INTO follow_ups
      (chat_jid, contact_name, due_date, due_time, context, source_wa_message_id, confidence, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
    [fu.chat_jid, fu.contact_name ?? null, fu.due_date, fu.due_time ?? null, fu.context,
     fu.source_wa_message_id ?? null, fu.confidence ?? null, fu.status ?? 'pending', t]);
  return rows[0].id as number;
}

export async function getDueFollowUps(dateStr: string): Promise<FollowUpRow[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM follow_ups WHERE due_date <= $1 AND status IN ('pending','confirmed','snoozed')
     ORDER BY due_date ASC, id ASC`, [dateStr]);
  return rows as FollowUpRow[];
}

export async function updateFollowUpStatus(
  id: number, status: FollowUpStatus, opts: { sentAt?: number } = {}): Promise<void> {
  await getPool().query(
    `UPDATE follow_ups SET status=$1, updated_at=$2, sent_at=COALESCE($3, sent_at) WHERE id=$4`,
    [status, now(), opts.sentAt ?? null, id]);
}

export async function hasActiveFollowUp(chatJid: string, dueDate: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM follow_ups WHERE chat_jid=$1 AND due_date=$2 AND status NOT IN ('cancelled','done') LIMIT 1`,
    [chatJid, dueDate]);
  return rows.length > 0;
}

export async function logEvent(type: string, payload: unknown): Promise<void> {
  await getPool().query(`INSERT INTO events (type, payload_json, created_at) VALUES ($1,$2,$3)`,
    [type, payload === undefined ? null : JSON.stringify(payload), now()]);
}
```

- [ ] **Step 2: Rewrite `test/worker.test.ts`** — make helpers awaited, ensureSchema once, truncate each test. (`processRow`/`hasActiveFollowUp` now imported from worker, which will be async in Task 3 — this test file still works because it `await`s them.)
```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ensureSchema, getPool, insertInboxMessage, getPendingInbox } from '../src/db.js';
import { processRow, hasActiveFollowUp } from '../src/worker.js';
import type { InboxRow } from '../src/db.js';

async function seedRow(over: Partial<{ wa: string; jid: string; name: string; text: string }> = {}): Promise<InboxRow> {
  const wa = over.wa ?? `m-${Math.floor(Math.random() * 1e9)}`;
  await insertInboxMessage({
    wa_message_id: wa, chat_jid: over.jid ?? 'jid-1@s.whatsapp.net',
    contact_name: over.name ?? 'Asha', from_me: false,
    text: over.text ?? 'let us talk', ts_unix: Math.floor(Date.now() / 1000),
  });
  return (await getPendingInbox(50)).find((r) => r.wa_message_id === wa)!;
}

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => {
  await getPool().query('TRUNCATE inbox, follow_ups, processed_messages, events RESTART IDENTITY');
});

describe('processRow', () => {
  it('inserts a follow-up (pending when confidence >= 0.6) and marks inbox done', async () => {
    const row = await seedRow();
    const out = await processRow(row, async () => ({ date: '2099-01-02', time: '10:00', context: 'call', confidence: 0.9 }));
    expect(out).toBe('done');
    const fu = (await getPool().query('SELECT * FROM follow_ups')).rows[0];
    expect(fu.due_date).toBe('2099-01-02');
    expect(fu.status).toBe('pending');
    expect(fu.source_wa_message_id).toBe(row.wa_message_id);
    expect(await getPendingInbox(50)).toHaveLength(0);
  });

  it('uses needs_review when confidence < 0.6', async () => {
    const row = await seedRow();
    await processRow(row, async () => ({ date: '2099-01-02', time: null, context: 'call', confidence: 0.4 }));
    expect((await getPool().query('SELECT status FROM follow_ups')).rows[0].status).toBe('needs_review');
  });

  it('creates no follow-up when extractor returns null but still marks inbox done', async () => {
    const row = await seedRow();
    expect(await processRow(row, async () => null)).toBe('done');
    expect((await getPool().query('SELECT COUNT(*)::int c FROM follow_ups')).rows[0].c).toBe(0);
    expect(await getPendingInbox(50)).toHaveLength(0);
  });

  it('leaves the row pending and inserts nothing when the extractor throws', async () => {
    const row = await seedRow();
    expect(await processRow(row, async () => { throw new Error('api down'); })).toBe('pending');
    expect((await getPool().query('SELECT COUNT(*)::int c FROM follow_ups')).rows[0].c).toBe(0);
    expect(await getPendingInbox(50)).toHaveLength(1);
  });

  it('skips duplicate follow-up for same chat_jid + due_date', async () => {
    const r1 = await seedRow({ wa: 'a' }); const r2 = await seedRow({ wa: 'b' });
    const extract = async () => ({ date: '2099-01-02', time: null, context: 'call', confidence: 0.9 });
    await processRow(r1, extract); await processRow(r2, extract);
    expect((await getPool().query('SELECT COUNT(*)::int c FROM follow_ups')).rows[0].c).toBe(1);
    expect(await hasActiveFollowUp('jid-1@s.whatsapp.net', '2099-01-02')).toBe(true);
  });
});
```

- [ ] **Step 2b: Run `npx vitest run test/db.test.ts` → still PASS** (helpers compile). worker.test will fail until Task 3 makes worker async — that's expected; do Task 3 next.

- [ ] **Step 3: Commit** `feat: port db helpers to async pg (boolean from_me, app-set timestamps)`.

---

## Task 3: Update callers to await (worker, listener, index, seed)

**Files:** `src/worker.ts`, `src/listener.ts`, `src/index.ts`, `scripts/seed-inbox.ts`.

- [ ] **Step 1: `src/worker.ts`** — remove the local `db.prepare` dedup; import `hasActiveFollowUp` from `./db.js`; `await` every db call in `processRow`. Replace the block:
```ts
import {
  getPendingInbox, getRecentMessagesForChat, insertFollowUp,
  markInboxDone, logEvent, hasActiveFollowUp, ensureSchema, type InboxRow,
} from './db.js';
// remove: db import, stmtActiveFollowUp, the local hasActiveFollowUp definition
```
In `processRow`: `const thread = (await getRecentMessagesForChat(row.chat_jid, 6)).map((r) => ({ fromMe: r.from_me, text: r.text }));` (note `from_me` is boolean now), and `if (await hasActiveFollowUp(...))`, `await insertFollowUp(...)`, `await logEvent(...)`, `await markInboxDone(...)`. In the direct-run guard call `await ensureSchema()` before `runLoop()`.

- [ ] **Step 2: `src/listener.ts`** — make `handleMessage` async; `await ensureSchema()` before `connect()`; in `messages.upsert` await each message sequentially:
```ts
sock.ev.on('messages.upsert', async (upsert) => {
  if (upsert.type !== 'notify') return;
  for (const msg of upsert.messages) {
    try { await handleMessage(msg); }
    catch (err) { logger.error({ err, key: msg.key }, 'failed to process message'); }
  }
});
```
and inside `handleMessage`: `if (await hasProcessed(waId)) return;`, `await insertInboxMessage({... from_me: fromMe ...})`, `await markProcessed(waId)`.

- [ ] **Step 3: `src/index.ts`** — `import { ensureSchema } from './db.js';` then `await ensureSchema();` before logging `ready` (replace the bare `import './db.js'`).

- [ ] **Step 4: `scripts/seed-inbox.ts`** — `await ensureSchema();` then `for (const m of samples) await insertInboxMessage(m);`.

- [ ] **Step 5: Run full `npx vitest run` → ALL pass; `npx tsc --noEmit` → exit 0.** Fix type fallout (e.g. any remaining `!!from_me`).

- [ ] **Step 6: Commit** `refactor: await async db layer across worker/listener/index/seed`.

---

## Task 4: Provision Neon + live smoke test (controller, uses MCP)

- [ ] **Step 1:** Via Neon MCP, fetch the pooled connection string for project `square-mud-98135286` and write it to `.env` as `DATABASE_URL=...` (gitignored). Update `.env.example` `DATABASE_URL=`.
- [ ] **Step 2:** Create the 4 tables in Neon by running `ensureSchema`'s DDL via MCP `run_sql` (or `npm run dev`, which calls ensureSchema then exits).
- [ ] **Step 3:** `npm run seed` then run the worker briefly → confirm rows land in Neon via MCP `run_sql` (`SELECT * FROM inbox`, `follow_ups`). Confirm dedup + statuses.
- [ ] **Step 4:** Commit any `.env.example`/doc tweaks.

## Verification (Phase 4a done when)
- `npx vitest run` green against pg-mem; `npx tsc --noEmit` clean.
- `npm run dev` runs `ensureSchema` against Neon without error; the 4 tables exist (MCP `run_sql`).
- `npm run seed` + worker write rows to Neon; pipeline behaves exactly as in Phase 3.
- Then STOP for user testing. Phase 4b (scheduler + WhatsApp self-delivery) is a separate plan.

## Self-review
- Coverage: pool+schema (T1), all 11 helpers async (T2), callers awaited (T3), Neon provisioned (T4).
- Type consistency: `from_me: boolean` in `InboxRow` + worker mapping; helpers return `Promise<…>`.
- pg-mem safety: no Postgres-only default funcs (timestamps app-set); `ON CONFLICT`, `RETURNING`,
  `TRUNCATE … RESTART IDENTITY`, `information_schema` are pg-mem-supported.
- Risk: if pg-mem rejects a statement, switch that test to a Neon test branch (note in plan).
