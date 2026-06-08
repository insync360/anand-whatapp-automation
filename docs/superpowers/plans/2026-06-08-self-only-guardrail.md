# "Only Message Me" Guardrail — Implementation Plan

> Spec: `docs/superpowers/specs/2026-06-08-self-only-guardrail-design.md`. One cohesive TDD change.

**Goal:** `makeDeliver` can only ever send to the linked account's own number, gated by a
`SELF_NUMBER` allowlist; callers can't pass a target.

## Task 1: harden makeDeliver + config + callers (TDD)
**Files:** `src/config.ts`, `.env.example`, `src/notify.ts`, `src/listener.ts`, `scripts/remind-now.ts`, `test/setup.ts`, `test/notify.test.ts`.

- [ ] **config.ts:** add `SELF_NUMBER: z.string().regex(/^\d{8,15}$/).optional(),` (near USER_NAME).
- [ ] **.env.example:** add `SELF_NUMBER=` with a comment `# your WhatsApp number in digits, e.g. 918460548054 — only this number is ever messaged`.
- [ ] **test/setup.ts:** add `process.env.SELF_NUMBER ??= '15550001111';`
- [ ] **Rewrite `test/notify.test.ts`** (signature is now `makeDeliver(sock?)`):
```ts
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ensureSchema, getPool, hasProcessed } from '../src/db.js';
import { makeDeliver } from '../src/notify.js';

const SELF = '15550001111'; // matches test/setup.ts SELF_NUMBER
function mkSock(number: string) {
  const calls: any[] = [];
  const sock = { user: { id: `${number}:12@s.whatsapp.net` }, sendMessage: async (jid: string, c: any) => { calls.push([jid, c]); return { key: { id: 'SENT1' } }; } } as any;
  return { calls, sock };
}

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await getPool().query('DELETE FROM processed_messages'); });

describe('makeDeliver guardrail', () => {
  it('console.logs even with no socket and never throws', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(makeDeliver()('hello')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith('hello');
    spy.mockRestore();
  });

  it('sends to the linked account own JID (device suffix stripped) when it matches SELF_NUMBER, and marks processed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls, sock } = mkSock(SELF);
    await makeDeliver(sock)('digest');
    expect(calls).toEqual([[`${SELF}@s.whatsapp.net`, { text: 'digest' }]]);
    expect(await hasProcessed('SENT1')).toBe(true);
    vi.restoreAllMocks();
  });

  it('REFUSES to send when the linked account does not match SELF_NUMBER', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls, sock } = mkSock('19998887777');
    await makeDeliver(sock)('digest');
    expect(calls).toEqual([]);
    expect(await hasProcessed('SENT1')).toBe(false);
    vi.restoreAllMocks();
  });

  it('never throws when sendMessage fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sock = { user: { id: `${SELF}@s.whatsapp.net` }, sendMessage: async () => { throw new Error('down'); } } as any;
    await expect(makeDeliver(sock)('x')).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});
```
Run `npx vitest run test/notify.test.ts` → FAIL (old signature).

- [ ] **Rewrite `src/notify.ts`:**
```ts
import { jidNormalizedUser, type WASocket } from '@whiskeysockets/baileys';
import { logger } from './logger.js';
import { markProcessed } from './db.js';
import { config } from './config.js';

/**
 * Build a reminder/ack deliverer. Always console.logs. If a live socket is given, it sends ONLY to
 * the linked account's own number (derived from the socket — callers cannot target anyone else),
 * and only if that number matches SELF_NUMBER when configured. Marks the echo processed. Never throws.
 */
export function makeDeliver(sock?: WASocket) {
  return async (text: string): Promise<void> => {
    console.log(text);
    try {
      if (!sock) return;
      const ownId = sock.user?.id;
      if (!ownId) { logger.warn('makeDeliver: socket has no user id; skipping WhatsApp send'); return; }
      const ownJid = jidNormalizedUser(ownId);
      const ownNumber = ownJid.split('@')[0];
      if (config.SELF_NUMBER && ownNumber !== config.SELF_NUMBER) {
        logger.error({ ownNumber, expected: config.SELF_NUMBER },
          'REFUSING WhatsApp send: linked account is not the configured SELF_NUMBER (only the owner may be messaged)');
        return;
      }
      const sent = await sock.sendMessage(ownJid, { text });
      const id = sent?.key?.id;
      if (id) await markProcessed(id);
    } catch (err) {
      logger.error({ err }, 'reminder delivery via WhatsApp failed');
    }
  };
}
```

- [ ] **src/listener.ts:** change both `makeDeliver(...)` calls to drop the second arg:
  - scheduler: `startScheduler((text) => makeDeliver(liveSock)(text));`
  - outbox poller: `deliver: makeDeliver(s),` (keep the `const s = liveSock; const j = liveSelfJid; if (!s || !j) return;` guard as-is).
- [ ] **scripts/remind-now.ts:** change `makeDeliver(sock, selfJid)` → `makeDeliver(sock)` (you may leave the now-unused `selfJid`/`jidNormalizedUser` if tsc doesn't error on unused; if tsc errors, remove the unused `selfJid` line and its `jidNormalizedUser` import).

- [ ] Run `npx vitest run` → all pass; `npx tsc --noEmit` → 0.
- [ ] Commit `feat: harden makeDeliver to only ever message the linked owner (SELF_NUMBER allowlist)`.

## Verification
- `npx vitest run` green; `tsc` clean. Mismatch test proves a non-self account is refused.
- After deploy + `SELF_NUMBER` set on the VM: a normal reminder/ack still delivers to the owner; the
  worker/listener logs show no `REFUSING` line (means the linked account matches).
