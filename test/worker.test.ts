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
  await getPool().query('DELETE FROM inbox');
  await getPool().query('DELETE FROM follow_ups');
  await getPool().query('DELETE FROM processed_messages');
  await getPool().query('DELETE FROM events');
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
