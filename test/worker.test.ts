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
