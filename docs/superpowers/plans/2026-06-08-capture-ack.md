# Capture Acknowledgment — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development (TDD per task).
> Spec: `docs/superpowers/specs/2026-06-08-capture-ack-design.md`.

**Goal:** Send an immediate WhatsApp ack to my own number when the worker records a follow-up, via a new `outbox` table the listener drains.

**Architecture:** Pure `ack.ts` formatter + `outbox` queue table + `drainOutbox` orchestration; worker enqueues, listener polls/sends with the existing `makeDeliver`. Reuses Neon/pg, pg-mem tests.

---

## Task 1: `src/ack.ts` — relativeDay + buildAck (TDD)
**Files:** create `src/ack.ts`, `test/ack.test.ts`.

- [ ] Write `test/ack.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { relativeDay, buildAck } from '../src/ack.js';

describe('relativeDay', () => {
  const today = '2026-06-08'; // Monday
  it('today / tomorrow', () => {
    expect(relativeDay(today, '2026-06-08')).toBe('today');
    expect(relativeDay(today, '2026-06-09')).toBe('tomorrow');
  });
  it('this <weekday> within the same week', () => {
    expect(relativeDay(today, '2026-06-12')).toBe('this Friday');
  });
  it('next <weekday> the following week', () => {
    expect(relativeDay(today, '2026-06-16')).toBe('next Tuesday'); // Tue next week
  });
  it('in N days when further out', () => {
    expect(relativeDay(today, '2026-06-30')).toBe('in 22 days');
  });
});

describe('buildAck', () => {
  const base = {
    userName: 'Anand', contactName: 'Ajeet', dueDate: '2026-06-16', dueTime: '16:00',
    context: 'get back about the proposal', today: '2026-06-08', status: 'pending' as const,
  };
  it('pending: recorded card with contact, date, relative, time, context', () => {
    const s = buildAck(base);
    expect(s).toContain('✅ *Follow-up recorded*');
    expect(s).toContain('Hi Anand');
    expect(s).toContain('Contact: *Ajeet*');
    expect(s).toContain('*Tue, 16 Jun 2026*');
    expect(s).toContain('at *16:00*');
    expect(s).toContain('(next Tuesday)');
    expect(s).toContain('📝 get back about the proposal');
  });
  it('needs_review: softer header and intro', () => {
    const s = buildAck({ ...base, status: 'needs_review' });
    expect(s).toContain('🤔 *Possible follow-up — saved for review*');
    expect(s).toContain("wasn't fully sure");
  });
  it('omits time when null and falls back for null contact', () => {
    const s = buildAck({ ...base, dueTime: null, contactName: null });
    expect(s).not.toContain(' at *');
    expect(s).toContain('Contact: *your contact*');
  });
});
```
- [ ] Run `npx vitest run test/ack.test.ts` → FAIL.
- [ ] Implement `src/ack.ts`:
```ts
const DAY = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const parseUTC = (ymd: string): number => Date.parse(`${ymd}T00:00:00Z`);
const mondayStart = (ms: number): number => {
  const dow = new Date(ms).getUTCDay();      // 0=Sun..6=Sat
  return ms - ((dow + 6) % 7) * DAY;          // back up to Monday
};

export function relativeDay(today: string, dueDate: string): string {
  const t = parseUTC(today);
  const d = parseUTC(dueDate);
  const days = Math.round((d - t) / DAY);
  if (days < 0) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  const weeks = Math.round((mondayStart(d) - mondayStart(t)) / (7 * DAY));
  const weekday = WEEKDAYS[new Date(d).getUTCDay()];
  if (weeks === 0) return `this ${weekday}`;
  if (weeks === 1) return `next ${weekday}`;
  return `in ${days} days`;
}

const prettyDate = (ymd: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(parseUTC(ymd));

export interface AckInput {
  userName: string; contactName: string | null; dueDate: string; dueTime: string | null;
  context: string; today: string; status: 'pending' | 'needs_review';
}

export function buildAck(i: AckInput): string {
  const contact = i.contactName ?? 'your contact';
  const time = i.dueTime ? ` at *${i.dueTime}*` : '';
  const rel = relativeDay(i.today, i.dueDate);
  const relSuffix = rel ? ` (${rel})` : '';
  const body =
    `👤 Contact: *${contact}*\n` +
    `📅 Due: *${prettyDate(i.dueDate)}*${time}${relSuffix}\n` +
    `📝 ${i.context}`;
  if (i.status === 'needs_review') {
    return `🤔 *Possible follow-up — saved for review*\n\nHi ${i.userName} 👋 I wasn't fully sure, but it sounded like:\n${body}`;
  }
  return `✅ *Follow-up recorded*\n\nHi ${i.userName} 👋\n${body}`;
}
```
- [ ] Run → PASS. `tsc` → 0. Commit `feat: add capture-ack message formatter (relativeDay + buildAck)`.

---

## Task 2: outbox table + db helpers + drainOutbox (TDD)
**Files:** modify `src/db.ts`; create `src/outbox.ts`, `test/outbox.test.ts`.

- [ ] In `src/db.ts` `ensureSchema`, add (after the `events` table):
```sql
    CREATE TABLE IF NOT EXISTS outbox (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent')),
      created_at BIGINT NOT NULL,
      sent_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status, id);
```
- [ ] In `src/db.ts`, add the type + helpers (use the existing `now()` and `getPool()`):
```ts
export interface OutboxRow { id: number; text: string; status: 'pending' | 'sent'; created_at: number; sent_at: number | null; }

export async function enqueueOutbox(text: string): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO outbox (text, status, created_at) VALUES ($1,'pending',$2) RETURNING id`, [text, now()]);
  return rows[0].id as number;
}
export async function getPendingOutbox(limit = 20): Promise<OutboxRow[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM outbox WHERE status='pending' ORDER BY id ASC LIMIT $1`, [limit]);
  return rows as OutboxRow[];
}
export async function markOutboxSent(id: number): Promise<void> {
  await getPool().query(`UPDATE outbox SET status='sent', sent_at=$1 WHERE id=$2`, [now(), id]);
}
```
- [ ] Create `src/outbox.ts`:
```ts
import type { OutboxRow } from './db.js';

export interface OutboxDeps {
  getPending: () => Promise<OutboxRow[]>;
  markSent: (id: number) => Promise<void>;
  deliver: (text: string) => Promise<void>;
}

/** Deliver each pending outbox row in order, marking it sent. Returns the count delivered. */
export async function drainOutbox(deps: OutboxDeps): Promise<number> {
  const rows = await deps.getPending();
  for (const r of rows) {
    await deps.deliver(r.text);
    await deps.markSent(r.id);
  }
  return rows.length;
}
```
- [ ] Write `test/outbox.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ensureSchema, getPool, enqueueOutbox, getPendingOutbox, markOutboxSent } from '../src/db.js';
import { drainOutbox } from '../src/outbox.js';

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await getPool().query('DELETE FROM outbox'); });

describe('outbox db helpers', () => {
  it('enqueue → getPending (ordered) → markSent removes from pending', async () => {
    const id1 = await enqueueOutbox('a');
    await enqueueOutbox('b');
    const pending = await getPendingOutbox(50);
    expect(pending.map((r) => r.text)).toEqual(['a', 'b']);
    await markOutboxSent(id1);
    expect((await getPendingOutbox(50)).map((r) => r.text)).toEqual(['b']);
    const sent = (await getPool().query('SELECT * FROM outbox WHERE id=$1', [id1])).rows[0];
    expect(sent.status).toBe('sent');
    expect(sent.sent_at).toBeGreaterThan(0);
  });
});

describe('drainOutbox', () => {
  it('delivers each pending row in order then marks sent; returns count', async () => {
    const delivered: string[] = []; const marked: number[] = [];
    await enqueueOutbox('m1'); await enqueueOutbox('m2');
    const n = await drainOutbox({
      getPending: () => getPendingOutbox(50),
      markSent: async (id) => { marked.push(id); await markOutboxSent(id); },
      deliver: async (t) => { delivered.push(t); },
    });
    expect(n).toBe(2);
    expect(delivered).toEqual(['m1', 'm2']);
    expect(await getPendingOutbox(50)).toHaveLength(0);
  });
  it('returns 0 when nothing pending', async () => {
    const n = await drainOutbox({ getPending: () => getPendingOutbox(50), markSent: markOutboxSent, deliver: async () => {} });
    expect(n).toBe(0);
  });
});
```
- [ ] Run `npx vitest run test/outbox.test.ts` → PASS (after impl). Full `npx vitest run` green; `tsc` 0. Commit `feat: add outbox table, db helpers, and drainOutbox`.

---

## Task 3: Integration — config, worker enqueue, listener poller
**Files:** `src/config.ts`, `.env.example`, `src/worker.ts`, `src/listener.ts`.

- [ ] `src/config.ts`: add `USER_NAME: z.string().min(1).default('Anand'),`. `.env.example`: add `USER_NAME=Anand`.
- [ ] `src/worker.ts`: import `enqueueOutbox` from `./db.js`, `buildAck` from `./ack.js`, `todayInTz` from `./extractor.js`, and `config` from `./config.js`. In `processRow`, inside the `else` block (where `insertFollowUp` runs), AFTER the `logEvent('followup_captured', …)` line, add:
```ts
      await enqueueOutbox(
        buildAck({
          userName: config.USER_NAME,
          contactName: row.contact_name,
          dueDate: result.date,
          dueTime: result.time,
          context: result.context,
          today: todayInTz(config.TIMEZONE),
          status,
        }),
      );
```
(`status` is the same `'pending' | 'needs_review'` computed just above.)
- [ ] `src/listener.ts`: import `getPendingOutbox, markOutboxSent` from `./db.js` and `drainOutbox` from `./outbox.js`. Add module flag `let outboxStarted = false;`. In the `connection === 'open'` branch, after the scheduler-start block, add:
```ts
          if (!outboxStarted) {
            setInterval(() => {
              if (!liveSock || !liveSelfJid) return; // only drain when connected
              void drainOutbox({
                getPending: () => getPendingOutbox(20),
                markSent: markOutboxSent,
                deliver: makeDeliver(liveSock, liveSelfJid),
              }).catch((err) => logger.error({ err }, 'outbox drain failed'));
            }, 5000);
            outboxStarted = true;
            logger.info('outbox poller started');
          }
```
- [ ] Run full `npx vitest run` (all pass — integration not unit-tested) and `npx tsc --noEmit` → 0. Commit `feat: enqueue capture ack in worker + drain outbox from listener; add USER_NAME`.

## Provisioning (controller, MCP)
- [ ] Create the `outbox` table + index in Neon (`square-mud-98135286`) via MCP `run_sql`.

## Verification (done when)
- `npx vitest run` green; `tsc` clean.
- Manual: with the listener + worker running, send yourself "let's reconnect next Tuesday" → a follow-up is recorded → within ~5s the ack card arrives on your WhatsApp self-chat; `outbox` row flips to `sent`.

## Self-review
- Coverage: ack format (T1), outbox queue + drain (T2), worker enqueue + listener poll + config (T3), Neon table.
- Loop-safety: poller skips when disconnected (no console-only false "sent"); ack echo deduped by makeDeliver.
