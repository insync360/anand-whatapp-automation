import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ensureSchema, getPool, hasProcessed } from '../src/db.js';
import { makeDeliver } from '../src/notify.js';

const SELF = '15550001111';
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
