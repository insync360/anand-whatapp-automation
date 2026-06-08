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
