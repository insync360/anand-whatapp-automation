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
