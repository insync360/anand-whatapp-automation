# Extraction Worker (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A separate worker process that drains the `inbox` queue, uses one Claude Haiku call to detect any agreed/implied next point of contact in any language, resolves it to an absolute date, and writes `follow_ups`.

**Architecture:** Three focused units — `src/extractor.ts` (pure LLM logic + date/TZ helpers, Anthropic client injectable), `src/worker.ts` (poll loop + `processRow` orchestration + dedup + backoff), `scripts/seed-inbox.ts` (test data). The regex gate is removed; `hasFollowUp:false` from the single combined call is the gate. Cost controlled via prompt caching + Haiku + tight `max_tokens` + 6-message window.

**Tech Stack:** Node 20+/TypeScript/tsx, `@anthropic-ai/sdk` (prompt caching, GA), `zod`, `better-sqlite3`, `vitest` (new, for TDD).

> **Design decisions (user-approved):** (A) remove regex `looksSchedulingRelated`; (B) add duplicate-follow-up safeguard (skip insert if an active follow-up already exists for same `chat_jid` + `due_date`). Reuses Phase 1 helpers: `getPendingInbox`, `getRecentMessagesForChat`, `insertFollowUp`, `markInboxDone`, `logEvent`, `insertInboxMessage`, exported `db`, type `InboxRow`; `config.{ANTHROPIC_API_KEY,MODEL,TIMEZONE}`; `logger`.

---

## File Structure
- `vitest.config.ts` (new) — test config + env (`DB_PATH=':memory:'`, dummy `ANTHROPIC_API_KEY`).
- `test/setup.ts` (new) — sets `process.env` before any module import.
- `src/extractor.ts` (new) — date/TZ helpers, `stripCodeFences`, zod schema, `extractFollowUp`.
- `src/worker.ts` (new) — `hasActiveFollowUp`, `processRow`, `runLoop`, entry guard.
- `scripts/seed-inbox.ts` (new) — sample inbox rows.
- `package.json` (modify) — add `vitest` dev dep + scripts `seed`, `start:worker`, `test`.
- Tests: `test/extractor.test.ts`, `test/worker.test.ts`.

---

## Task 1: Test infrastructure + date/TZ helpers

**Files:**
- Create: `vitest.config.ts`, `test/setup.ts`, `src/extractor.ts`, `test/extractor.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add vitest + scripts to package.json**

Add to `devDependencies`: `"vitest": "^2.1.8"`. Add to `scripts`:
```json
"seed": "tsx scripts/seed-inbox.ts",
"start:worker": "tsx src/worker.ts",
"test": "vitest run",
"test:watch": "vitest"
```
Then run: `npm install`

- [ ] **Step 2: Create test env setup**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
});
```
`test/setup.ts` (runs before modules load, so config/db pick these up):
```ts
process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.DB_PATH ??= ':memory:';
process.env.TIMEZONE ??= 'Asia/Kolkata';
process.env.LOG_LEVEL ??= 'silent';
```

- [ ] **Step 3: Write failing test for date/TZ helpers**

`test/extractor.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ymdInTz, prettyInTz, todayInTz, stripCodeFences } from '../src/extractor.js';

describe('date/tz helpers', () => {
  // 2026-06-08T20:00:00Z == 2026-06-09 01:30 IST (Asia/Kolkata, +5:30)
  const unix = Math.floor(Date.parse('2026-06-08T20:00:00Z') / 1000);

  it('ymdInTz returns the local YYYY-MM-DD in the timezone', () => {
    expect(ymdInTz(unix, 'Asia/Kolkata')).toBe('2026-06-09');
    expect(ymdInTz(unix, 'UTC')).toBe('2026-06-08');
  });

  it('prettyInTz includes weekday and timezone label', () => {
    const s = prettyInTz(unix, 'Asia/Kolkata');
    expect(s).toContain('Asia/Kolkata');
    expect(s).toMatch(/Tuesday/); // 2026-06-09 is a Tuesday
  });

  it('todayInTz returns an ISO date string', () => {
    expect(todayInTz('Asia/Kolkata')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('stripCodeFences', () => {
  it('removes ```json fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('removes bare ``` fences', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('leaves unfenced text unchanged', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/extractor.test.ts`
Expected: FAIL — cannot import `ymdInTz` / module has no exports.

- [ ] **Step 5: Implement helpers in src/extractor.ts**

```ts
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './logger.js';

export function ymdInTz(unixSeconds: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}

export function prettyInTz(unixSeconds: number, tz: string): string {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(unixSeconds * 1000));
  return `${s} (${tz})`;
}

export function todayInTz(tz: string): string {
  return ymdInTz(Math.floor(Date.now() / 1000), tz);
}

export function stripCodeFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/extractor.test.ts`
Expected: PASS (all 6 specs in this file so far).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts test/setup.ts src/extractor.ts test/extractor.test.ts
git commit -m "test: add vitest + extractor date/tz + stripCodeFences helpers"
```

---

## Task 2: Extraction schema + `extractFollowUp` (injected client)

**Files:**
- Modify: `src/extractor.ts`, `test/extractor.test.ts`

- [ ] **Step 1: Write failing tests for extractFollowUp**

Append to `test/extractor.test.ts`:
```ts
import { extractFollowUp, ExtractionSchema } from '../src/extractor.js';

function fakeClient(text: string) {
  return { messages: { create: async () => ({ content: [{ type: 'text', text }] }) } } as any;
}
const baseInput = {
  thread: [{ fromMe: false, text: 'Shall we talk next week?' }],
  contactName: 'Asha',
  messageTimestampUnix: Math.floor(Date.parse('2026-06-08T06:00:00Z') / 1000),
};

describe('extractFollowUp', () => {
  it('returns a result for a concrete future follow-up', async () => {
    const r = await extractFollowUp(baseInput, fakeClient(
      '{"hasFollowUp":true,"date":"2099-06-16","time":"16:00","context":"call about proposal","confidence":0.9}',
    ));
    expect(r).toEqual({ date: '2099-06-16', time: '16:00', context: 'call about proposal', confidence: 0.9 });
  });

  it('returns null when hasFollowUp is false', async () => {
    const r = await extractFollowUp(baseInput, fakeClient('{"hasFollowUp":false,"date":null,"time":null,"context":"","confidence":0.1}'));
    expect(r).toBeNull();
  });

  it('returns null when the date is in the past', async () => {
    const r = await extractFollowUp(baseInput, fakeClient('{"hasFollowUp":true,"date":"2000-01-01","time":null,"context":"x","confidence":0.9}'));
    expect(r).toBeNull();
  });

  it('strips code fences before parsing', async () => {
    const r = await extractFollowUp(baseInput, fakeClient('```json\n{"hasFollowUp":true,"date":"2099-01-02","time":null,"context":"x","confidence":0.7}\n```'));
    expect(r?.date).toBe('2099-01-02');
  });

  it('returns null on malformed JSON (does not throw)', async () => {
    const r = await extractFollowUp(baseInput, fakeClient('not json at all'));
    expect(r).toBeNull();
  });

  it('propagates API/network errors (so the worker can retry)', async () => {
    const throwing = { messages: { create: async () => { throw new Error('rate limit'); } } } as any;
    await expect(extractFollowUp(baseInput, throwing)).rejects.toThrow('rate limit');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/extractor.test.ts`
Expected: FAIL — `extractFollowUp` / `ExtractionSchema` not exported.

- [ ] **Step 3: Implement schema, types, and extractFollowUp**

Append to `src/extractor.ts`:
```ts
export const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export const ExtractionSchema = z.object({
  hasFollowUp: z.boolean(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  context: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface ThreadMessage { fromMe: boolean; text: string; }
export interface ExtractInput {
  thread: ThreadMessage[];
  contactName: string | null;
  messageTimestampUnix: number;
}
export interface FollowUpResult { date: string; time: string | null; context: string; confidence: number; }

const SYSTEM_PROMPT = `You read a short 1:1 chat conversation and decide whether the two people have agreed on, or clearly implied, a concrete NEXT POINT OF CONTACT (a call, meeting, message, or follow-up) by EITHER person.

Rules:
- Understand ANY language, including Hindi, English, and romanized/transliterated mixes (Hinglish). "kal" = tomorrow, "parso" = day after, "agle hafte" = next week, "agle mahine" = next month.
- Resolve every relative date ("Tuesday", "next week", "after Diwali", "kal") to an ABSOLUTE calendar date in YYYY-MM-DD, computed from the provided "Current message time" and timezone. If a weekday is named, pick the next future occurrence.
- Only set hasFollowUp=true when the plan is reasonably concrete (a resolvable day). Vague intentions ("let's catch up sometime", "I'll see") => hasFollowUp=false.
- time is 24h HH:MM if an explicit time is given, else null.
- context: a short (<=120 char) one-line summary of what the contact is, e.g. "call to finalize contract".
- confidence: 0..1, how sure you are this is a real, dated follow-up.

Respond with ONLY a JSON object, no prose, no code fences:
{"hasFollowUp": boolean, "date": "YYYY-MM-DD"|null, "time": "HH:MM"|null, "context": string, "confidence": number}

Examples:
Conversation: Me: Can we finalize the contract? / Asha: Sure, let's connect Tuesday at 4pm.
(message time Saturday 2026-06-06) -> {"hasFollowUp":true,"date":"2026-06-09","time":"16:00","context":"call to finalize the contract","confidence":0.95}

Conversation: Ravi: thik hai, agle hafte call karte hain
(message time Monday 2026-06-08) -> {"hasFollowUp":true,"date":"2026-06-15","time":null,"context":"call next week","confidence":0.7}

Conversation: Me: haha that movie was great
(message time 2026-06-08) -> {"hasFollowUp":false,"date":null,"time":null,"context":"","confidence":0.95}`;

export async function extractFollowUp(
  input: ExtractInput,
  client: Pick<Anthropic, 'messages'> = anthropic,
): Promise<FollowUpResult | null> {
  const { thread, contactName, messageTimestampUnix } = input;
  const tz = config.TIMEZONE;
  const who = contactName ?? 'Contact';
  const convo = thread.map((m) => `${m.fromMe ? 'Me' : who}: ${m.text}`).join('\n');
  const userContent =
    `Timezone: ${tz}\n` +
    `Current message time: ${prettyInTz(messageTimestampUnix, tz)}\n\n` +
    `Conversation (most recent last):\n${convo}`;

  const resp = await client.messages.create({
    model: config.MODEL,
    max_tokens: 300,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });

  let parsed: Extraction;
  try {
    const block = resp.content.find((b) => b.type === 'text');
    const raw = block && 'text' in block ? block.text : '';
    parsed = ExtractionSchema.parse(JSON.parse(stripCodeFences(raw)));
  } catch (err) {
    logger.warn({ err }, 'extractFollowUp: could not parse/validate LLM output');
    return null;
  }

  if (!parsed.hasFollowUp || !parsed.date) return null;
  if (parsed.date < todayInTz(tz)) return null;
  return { date: parsed.date, time: parsed.time, context: parsed.context, confidence: parsed.confidence };
}
```
> Note: API errors are intentionally NOT caught (they propagate); only JSON/zod errors return null. Follow the **claude-api skill** if any caching/SDK detail needs confirming.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/extractor.test.ts`
Expected: PASS (all extractor specs).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/extractor.ts test/extractor.test.ts
git commit -m "feat: add extractFollowUp single combined Haiku call with zod validation"
```

---

## Task 3: Worker `processRow` + dedup (real in-memory DB, fake extractor)

**Files:**
- Create: `src/worker.ts`, `test/worker.test.ts`

- [ ] **Step 1: Write failing tests for processRow**

`test/worker.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db, insertInboxMessage, getPendingInbox } from '../src/db.js';
import { processRow, hasActiveFollowUp } from '../src/worker.js';
import type { InboxRow } from '../src/db.js';

function seedRow(over: Partial<{ wa: string; jid: string; name: string; text: string }> = {}): InboxRow {
  const wa = over.wa ?? `m-${Math.floor(Math.random() * 1e9)}`;
  insertInboxMessage({
    wa_message_id: wa, chat_jid: over.jid ?? 'jid-1@s.whatsapp.net',
    contact_name: over.name ?? 'Asha', from_me: false,
    text: over.text ?? 'let us talk', ts_unix: Math.floor(Date.now() / 1000),
  });
  return getPendingInbox(50).find((r) => r.wa_message_id === wa)!;
}

beforeEach(() => {
  db.exec('DELETE FROM inbox; DELETE FROM follow_ups; DELETE FROM processed_messages; DELETE FROM events;');
});

describe('processRow', () => {
  it('inserts a follow-up (status pending when confidence >= 0.6) and marks inbox done', async () => {
    const row = seedRow();
    const out = await processRow(row, async () => ({ date: '2099-01-02', time: '10:00', context: 'call', confidence: 0.9 }));
    expect(out).toBe('done');
    const fu = db.prepare('SELECT * FROM follow_ups').get() as any;
    expect(fu.due_date).toBe('2099-01-02');
    expect(fu.status).toBe('pending');
    expect(fu.source_wa_message_id).toBe(row.wa_message_id);
    expect(getPendingInbox(50)).toHaveLength(0);
  });

  it('uses needs_review when confidence < 0.6', async () => {
    const row = seedRow();
    await processRow(row, async () => ({ date: '2099-01-02', time: null, context: 'call', confidence: 0.4 }));
    expect((db.prepare('SELECT status FROM follow_ups').get() as any).status).toBe('needs_review');
  });

  it('creates no follow-up when extractor returns null but still marks inbox done', async () => {
    const row = seedRow();
    const out = await processRow(row, async () => null);
    expect(out).toBe('done');
    expect(db.prepare('SELECT COUNT(*) c FROM follow_ups').get() as any).toEqual({ c: 0 });
    expect(getPendingInbox(50)).toHaveLength(0);
  });

  it('leaves the row pending and inserts nothing when the extractor throws', async () => {
    const row = seedRow();
    const out = await processRow(row, async () => { throw new Error('api down'); });
    expect(out).toBe('pending');
    expect((db.prepare('SELECT COUNT(*) c FROM follow_ups').get() as any).c).toBe(0);
    expect(getPendingInbox(50)).toHaveLength(1);
  });

  it('skips duplicate follow-up for same chat_jid + due_date', async () => {
    const r1 = seedRow({ wa: 'a' });
    const r2 = seedRow({ wa: 'b' });
    const extract = async () => ({ date: '2099-01-02', time: null, context: 'call', confidence: 0.9 });
    await processRow(r1, extract);
    await processRow(r2, extract);
    expect((db.prepare('SELECT COUNT(*) c FROM follow_ups').get() as any).c).toBe(1);
    expect(hasActiveFollowUp('jid-1@s.whatsapp.net', '2099-01-02')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/worker.test.ts`
Expected: FAIL — `processRow` / `hasActiveFollowUp` not exported (module missing).

- [ ] **Step 3: Implement src/worker.ts**

```ts
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  db, getPendingInbox, getRecentMessagesForChat, insertFollowUp,
  markInboxDone, logEvent, type InboxRow,
} from './db.js';
import { extractFollowUp, type ExtractInput, type FollowUpResult } from './extractor.js';

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 4000);
const CONFIDENCE_THRESHOLD = 0.6;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60000;

const stmtActiveFollowUp = db.prepare(
  `SELECT 1 FROM follow_ups WHERE chat_jid = ? AND due_date = ? AND status NOT IN ('cancelled','done') LIMIT 1`,
);
export function hasActiveFollowUp(chatJid: string, dueDate: string): boolean {
  return stmtActiveFollowUp.get(chatJid, dueDate) !== undefined;
}

type ExtractFn = (input: ExtractInput) => Promise<FollowUpResult | null>;

export async function processRow(row: InboxRow, extract: ExtractFn = extractFollowUp): Promise<'done' | 'pending'> {
  const thread = getRecentMessagesForChat(row.chat_jid, 6).map((r) => ({ fromMe: !!r.from_me, text: r.text }));
  let result: FollowUpResult | null;
  try {
    result = await extract({ thread, contactName: row.contact_name, messageTimestampUnix: row.ts_unix });
  } catch (err) {
    logger.error({ err, inboxId: row.id }, 'extraction failed; leaving row pending');
    return 'pending';
  }
  if (result) {
    if (hasActiveFollowUp(row.chat_jid, result.date)) {
      logger.info({ chatJid: row.chat_jid, dueDate: result.date }, 'duplicate follow-up skipped');
    } else {
      const status = result.confidence >= CONFIDENCE_THRESHOLD ? 'pending' : 'needs_review';
      const id = insertFollowUp({
        chat_jid: row.chat_jid, contact_name: row.contact_name,
        due_date: result.date, due_time: result.time, context: result.context,
        source_wa_message_id: row.wa_message_id, confidence: result.confidence, status,
      });
      logEvent('followup_captured', { followUpId: id, chatJid: row.chat_jid, dueDate: result.date, confidence: result.confidence, status });
      logger.info({ followUpId: id, dueDate: result.date, status }, 'follow-up captured');
    }
  }
  markInboxDone(row.id);
  return 'done';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runLoop(): Promise<void> {
  let failures = 0;
  logger.info({ pollMs: POLL_MS }, 'extraction worker started');
  for (;;) {
    let hadError = false;
    for (const row of getPendingInbox(20)) {
      if ((await processRow(row)) === 'pending') { hadError = true; break; }
    }
    if (hadError) {
      failures += 1;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
      logger.warn({ failures, delayMs: delay }, 'backing off after extraction error');
      await sleep(delay);
    } else {
      failures = 0;
      await sleep(POLL_MS);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.on('SIGINT', () => { logger.info('worker shutting down'); process.exit(0); });
  process.on('SIGTERM', () => { logger.info('worker shutting down'); process.exit(0); });
  void runLoop();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/worker.test.ts`
Expected: PASS (all 5 worker specs).

- [ ] **Step 5: Full test + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts test/worker.test.ts
git commit -m "feat: add extraction worker processRow, dedup guard, and poll loop"
```

---

## Task 4: Seed script

**Files:**
- Create: `scripts/seed-inbox.ts`

- [ ] **Step 1: Implement the seed script**

```ts
import { insertInboxMessage } from '../src/db.js';
import { logger } from '../src/logger.js';

const now = Math.floor(Date.now() / 1000);
const samples = [
  { wa_message_id: `seed-clear-${now}`, chat_jid: 'seed-asha@s.whatsapp.net', contact_name: 'Asha',
    from_me: false, text: "Perfect, let's connect on Tuesday at 4pm to finalize the contract.", ts_unix: now },
  { wa_message_id: `seed-hinglish-${now}`, chat_jid: 'seed-ravi@s.whatsapp.net', contact_name: 'Ravi',
    from_me: false, text: 'thik hai, agle hafte call karte hain', ts_unix: now },
  { wa_message_id: `seed-chitchat-${now}`, chat_jid: 'seed-meera@s.whatsapp.net', contact_name: 'Meera',
    from_me: false, text: 'Haha 😂 that movie was hilarious, loved the ending!', ts_unix: now },
];

for (const m of samples) insertInboxMessage(m);
logger.info(`seeded ${samples.length} inbox messages`);
```

- [ ] **Step 2: Verify it runs and inserts rows**

Run (real key not needed for seed, but config requires the var; use a placeholder if no `.env`):
`npm run seed`
Expected: logs `seeded 3 inbox messages`. (If `.env` lacks `ANTHROPIC_API_KEY`, set one placeholder to pass config validation — seed makes no API calls.)

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-inbox.ts
git commit -m "feat: add inbox seed script for worker testing"
```

---

## Verification (end-to-end, user runs with a real ANTHROPIC_API_KEY)
1. `npm install` then `npx vitest run` → all tests green; `npx tsc --noEmit` → exit 0.
2. `npm run seed` → 3 inbox rows.
3. `npm run start:worker` (real key in `.env`):
   - `seed-asha` → follow-up, `due_date` = next Tuesday, `due_time` `16:00`, status `pending`.
   - `seed-ravi` → follow-up, `due_date` ≈ today+1 week, status by confidence.
   - `seed-meera` → no follow-up.
   - All three inbox rows end `status='done'`; `events` has `followup_captured` rows.
   - Inspect via a one-off tsx query of `follow_ups`/`inbox` (as in earlier phases).
4. Error path (no/invalid key): worker logs the Anthropic error and leaves rows `pending` (no loss), backing off — confirmable without a valid key.

## Self-Review notes
- Spec coverage: gate-via-LLM ✅(Task 2), absolute-date resolution ✅(prompt+todayInTz), confidence→status ✅(Task 3), error→leave pending+backoff ✅(Task 3), dedup ✅(Task 3), seed ✅(Task 4), prompt caching ✅(cache_control in Task 2).
- Type consistency: `ExtractInput`/`FollowUpResult`/`ThreadMessage` defined in extractor (Task 2) and consumed in worker (Task 3) with matching shapes; `InboxRow` from db.ts.
- No placeholders: all steps contain runnable code/commands.
- Git note: repo is not yet a git repo (`git init` on first commit, or skip commits and rely on tests/typecheck as the per-task gate).
```
