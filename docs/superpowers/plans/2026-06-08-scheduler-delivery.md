# Phase 4b — Scheduler + WhatsApp Self-Delivery (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (TDD per task).
> Design spec: `docs/superpowers/specs/2026-06-08-neon-migration-and-scheduler-design.md`.

**Goal:** Daily reminder digest of due follow-ups, delivered to the user's OWN WhatsApp number
(self-chat) via the existing linked Baileys session, marking delivered rows `sent`.

**Architecture:** `notify.ts` (`makeDeliver` — console + optional WhatsApp send, never throws,
markProcessed the echo). `scheduler.ts` (pure `buildDigest` + `runReminders(deps)` + `startScheduler`
cron + prod wiring). Cron runs INSIDE the listener process (holds the socket). `remind:now` one-shot
for testing. CLAUDE.md constraints rewritten.

**Tech Stack:** Node/TS/tsx, `node-cron`, Baileys, `pg` (Neon), vitest + pg-mem.

> Decisions: WhatsApp self-delivery (overrides read-only). `getDue` = `getDueFollowUps` filtered to
> status ∈ (pending,confirmed) per spec. Reuses `todayInTz` (extractor), `getDueFollowUps`,
> `updateFollowUpStatus`, `logEvent`, `markProcessed`, type `FollowUpRow`.

---

## Task 1: `src/notify.ts` — makeDeliver (TDD)
**Files:** Create `src/notify.ts`, `test/notify.test.ts`.

- [ ] Write `test/notify.test.ts` (uses pg-mem via setup):
```ts
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ensureSchema, getPool, hasProcessed } from '../src/db.js';
import { makeDeliver } from '../src/notify.js';

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await getPool().query('DELETE FROM processed_messages'); });

describe('makeDeliver', () => {
  it('console.logs the text even with no socket', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeDeliver()('hello');
    expect(spy).toHaveBeenCalledWith('hello');
    spy.mockRestore();
  });

  it('sends via the socket and marks the sent message processed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const calls: any[] = [];
    const sock = { sendMessage: async (jid: string, content: any) => { calls.push([jid, content]); return { key: { id: 'SENT1' } }; } } as any;
    await makeDeliver(sock, 'me@s.whatsapp.net')('digest');
    expect(calls).toEqual([['me@s.whatsapp.net', { text: 'digest' }]]);
    expect(await hasProcessed('SENT1')).toBe(true);
  });

  it('never throws when sendMessage fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sock = { sendMessage: async () => { throw new Error('socket down'); } } as any;
    await expect(makeDeliver(sock, 'me@s.whatsapp.net')('x')).resolves.toBeUndefined();
  });
});
```
- [ ] Run → FAIL. Implement `src/notify.ts`:
```ts
import type { WASocket } from '@whiskeysockets/baileys';
import { logger } from './logger.js';
import { markProcessed } from './db.js';

/**
 * Build a reminder deliverer. Always console.logs. If a live socket + selfJid are
 * given, also sends the text to the user's own WhatsApp chat and marks the echoed
 * message processed (so the listener's dedup ignores our own reminder). Never throws.
 */
export function makeDeliver(sock?: WASocket, selfJid?: string) {
  return async (text: string): Promise<void> => {
    console.log(text);
    try {
      if (sock && selfJid) {
        const sent = await sock.sendMessage(selfJid, { text });
        const id = sent?.key?.id;
        if (id) await markProcessed(id);
      }
    } catch (err) {
      logger.error({ err }, 'reminder delivery via WhatsApp failed');
    }
  };
}
```
- [ ] Run → PASS. `tsc --noEmit` → 0. Commit `feat: add WhatsApp reminder deliverer (never-throws)`.

---

## Task 2: `src/scheduler.ts` — buildDigest + runReminders + cron (TDD)
**Files:** Create `src/scheduler.ts`, `test/scheduler.test.ts`.

- [ ] Write `test/scheduler.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { buildDigest, runReminders } from '../src/scheduler.js';
import type { FollowUpRow } from '../src/db.js';

const fu = (over: Partial<FollowUpRow>): FollowUpRow => ({
  id: 1, chat_jid: 'c', contact_name: 'Asha', due_date: '2026-06-08', due_time: null,
  context: 'call', source_wa_message_id: null, confidence: 0.9, status: 'pending',
  created_at: 0, updated_at: 0, sent_at: null, ...over,
});

describe('buildDigest', () => {
  it('header has the date and count; lists each item', () => {
    const s = buildDigest('2026-06-08', [fu({ id: 1, contact_name: 'Asha', context: 'call', due_time: '16:00' })]);
    expect(s).toContain('📌 Follow-ups for 2026-06-08 (1):');
    expect(s).toContain('• Asha 16:00 — call');
  });
  it('annotates overdue items and omits time when null', () => {
    const s = buildDigest('2026-06-08', [fu({ contact_name: 'Ravi', context: 'proposal', due_date: '2026-06-05', due_time: null })]);
    expect(s).toContain('• Ravi — proposal (was due 2026-06-05)');
  });
  it('sorts by date then time', () => {
    const lines = buildDigest('2026-06-09', [
      fu({ id: 1, contact_name: 'B', due_date: '2026-06-09', due_time: '15:00', context: 'b' }),
      fu({ id: 2, contact_name: 'A', due_date: '2026-06-08', due_time: null, context: 'a' }),
      fu({ id: 3, contact_name: 'C', due_date: '2026-06-09', due_time: '09:00', context: 'c' }),
    ]).split('\n').slice(1);
    expect(lines.map((l) => l[2])).toEqual(['A', 'C', 'B']); // char after "• "
  });
});

describe('runReminders', () => {
  it('delivers digest, marks each sent, logs events', async () => {
    const due = [fu({ id: 7, due_date: '2026-06-08' }), fu({ id: 8, due_date: '2026-06-08' })];
    const delivered: string[] = []; const sent: Array<[number, number]> = []; const events: any[] = [];
    const res = await runReminders({
      today: '2026-06-08', now: 1000,
      getDue: async () => due,
      markSent: async (id, at) => { sent.push([id, at]); },
      deliver: async (t) => { delivered.push(t); },
      logEvent: async (type, p) => { events.push([type, p]); },
    });
    expect(res).toEqual({ count: 2, delivered: true });
    expect(delivered).toHaveLength(1);
    expect(sent).toEqual([[7, 1000], [8, 1000]]);
    expect(events.map((e) => e[0])).toEqual(['reminder_sent', 'reminder_sent']);
  });
  it('does nothing when none are due', async () => {
    const delivered: string[] = [];
    const res = await runReminders({
      today: '2026-06-08', now: 1000, getDue: async () => [],
      markSent: async () => {}, deliver: async (t) => { delivered.push(t); }, logEvent: async () => {},
    });
    expect(res).toEqual({ count: 0, delivered: false });
    expect(delivered).toHaveLength(0);
  });
});
```
- [ ] Run → FAIL. Implement `src/scheduler.ts`:
```ts
import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { todayInTz } from './extractor.js';
import { getDueFollowUps, updateFollowUpStatus, logEvent, type FollowUpRow } from './db.js';

export interface ReminderDeps {
  today: string;
  now: number;
  getDue: (today: string) => Promise<FollowUpRow[]>;
  markSent: (id: number, sentAt: number) => Promise<void>;
  deliver: (text: string) => Promise<void>;
  logEvent: (type: string, payload: unknown) => Promise<void>;
}

export function buildDigest(today: string, due: FollowUpRow[]): string {
  const sorted = [...due].sort(
    (a, b) => a.due_date.localeCompare(b.due_date) || (a.due_time ?? '99:99').localeCompare(b.due_time ?? '99:99'),
  );
  const lines = sorted.map((f) => {
    const contact = f.contact_name ?? 'Unknown';
    const time = f.due_time ? ` ${f.due_time}` : '';
    const overdue = f.due_date < today ? ` (was due ${f.due_date})` : '';
    return `• ${contact}${time} — ${f.context}${overdue}`;
  });
  return `📌 Follow-ups for ${today} (${due.length}):\n${lines.join('\n')}`;
}

export async function runReminders(deps: ReminderDeps): Promise<{ count: number; delivered: boolean }> {
  const due = await deps.getDue(deps.today);
  if (due.length === 0) { logger.info('no follow-ups due'); return { count: 0, delivered: false }; }
  await deps.deliver(buildDigest(deps.today, due));
  for (const f of due) {
    await deps.markSent(f.id, deps.now);
    await deps.logEvent('reminder_sent', { followUpId: f.id, dueDate: f.due_date });
  }
  logger.info({ count: due.length }, 'reminders delivered');
  return { count: due.length, delivered: true };
}

/** Production deps wiring: due = pending/confirmed only, per spec. */
export function runRemindersProd(deliver: (text: string) => Promise<void>) {
  return runReminders({
    today: todayInTz(config.TIMEZONE),
    now: Math.floor(Date.now() / 1000),
    getDue: async (t) => (await getDueFollowUps(t)).filter((f) => f.status === 'pending' || f.status === 'confirmed'),
    markSent: (id, sentAt) => updateFollowUpStatus(id, 'sent', { sentAt }),
    deliver,
    logEvent,
  });
}

export function startScheduler(deliver: (text: string) => Promise<void>): void {
  const expr = `0 ${config.REMINDER_HOUR} * * *`;
  cron.schedule(expr, () => { void runRemindersProd(deliver).catch((err) => logger.error({ err }, 'reminder run failed')); },
    { timezone: config.TIMEZONE });
  logger.info({ cron: expr, tz: config.TIMEZONE }, 'reminder scheduler started');
}
```
- [ ] Run → PASS. `tsc` → 0. Commit `feat: add reminder scheduler (digest + runReminders + cron)`.

---

## Task 3: Integration — listener cron, remind:now, scripts, CLAUDE.md
**Files:** `src/listener.ts`, `scripts/remind-now.ts` (new), `package.json`, `CLAUDE.md`.

- [ ] `src/listener.ts`: import `jidNormalizedUser` from baileys, `startScheduler` from `./scheduler.js`, `makeDeliver` from `./notify.js`. Add module flag `let schedulerStarted = false;`. In the `connection === 'open'` branch:
```ts
if (connection === 'open') {
  reconnectAttempts = 0;
  logger.info('linked / listening');
  if (!schedulerStarted && sock.user?.id) {
    const selfJid = jidNormalizedUser(sock.user.id);
    startScheduler(makeDeliver(sock, selfJid));
    schedulerStarted = true;
  }
}
```
Update the file's top docblock: it now ALSO sends reminders to the user's own number (no longer "strictly read-only" — capture is read-only, delivery sends only to self).
- [ ] Create `scripts/remind-now.ts` (one-shot; run with listener STOPPED):
```ts
import makeWASocket, { fetchLatestBaileysVersion, useMultiFileAuthState, jidNormalizedUser } from '@whiskeysockets/baileys';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { ensureSchema } from '../src/db.js';
import { makeDeliver } from '../src/notify.js';
import { runRemindersProd } from '../src/scheduler.js';

await ensureSchema();
const { version } = await fetchLatestBaileysVersion();
const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);
const sock = makeWASocket({ version, auth: state, logger: logger.child({ module: 'baileys' }, { level: 'warn' }) });
sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', async (u) => {
  if (u.connection === 'open' && sock.user?.id) {
    const selfJid = jidNormalizedUser(sock.user.id);
    const res = await runRemindersProd(makeDeliver(sock, selfJid));
    logger.info(res, 'remind:now complete');
    setTimeout(() => process.exit(0), 1500); // let the send flush
  }
});
```
- [ ] `package.json`: add `"remind:now": "tsx scripts/remind-now.ts"`.
- [ ] `CLAUDE.md`: rewrite the two "Hard constraints" bullets → WhatsApp send permitted ONLY for self-reminders; delivery via WhatsApp self-chat; durable store = Neon Postgres (not SQLite). Update the architecture/tech-stack lines that say SQLite/Telegram accordingly.
- [ ] `npx vitest run` (all green — integration files aren't unit-tested but must compile), `npx tsc --noEmit` → 0. Commit `feat: wire reminder delivery into listener + add remind:now; update CLAUDE.md`.

## Verification (Phase 4b done when)
- `npx vitest run` green; `npx tsc --noEmit` clean.
- Seed a follow-up due today (e.g. via MCP insert or a tweaked seed), stop the listener, `npm run remind:now` → digest posted to the user's WhatsApp self-chat; those rows flip to `sent` (verify via MCP `run_sql`).
- Then STOP for user testing.

## Self-review
- Coverage: notify (T1), digest+runReminders+cron (T2), listener cron + remind:now + scripts + CLAUDE.md (T3).
- Feedback loop handled via markProcessed of the sent id (T1).
- getDue filtered to pending/confirmed per spec (snoozed excluded — flag to user).
