import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  ensureSchema, getPool, insertInboxMessage, getPendingInbox, markInboxDone,
  hasProcessed, markProcessed, getRecentMessagesForChat, insertFollowUp,
  getDueFollowUps, updateFollowUpStatus, hasActiveFollowUp, logEvent,
} from '../src/db.js';

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM events');
  await pool.query('DELETE FROM follow_ups');
  await pool.query('DELETE FROM processed_messages');
  await pool.query('DELETE FROM inbox');
});

const baseMsg = (over: Partial<{ wa: string; jid: string; from_me: boolean; text: string; ts: number }> = {}) => ({
  wa_message_id: over.wa ?? 'w1', chat_jid: over.jid ?? 'c1', contact_name: 'Asha',
  from_me: over.from_me ?? false, text: over.text ?? 'hi', ts_unix: over.ts ?? 1000,
});

describe('inbox helpers', () => {
  it('inserts and returns id; dedups on wa_message_id returning the same id', async () => {
    const id1 = await insertInboxMessage(baseMsg({ wa: 'dup' }));
    const id2 = await insertInboxMessage(baseMsg({ wa: 'dup', text: 'changed' }));
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBe(id1);
    const res = await getPool().query('SELECT COUNT(*) AS c FROM inbox');
    expect(Number(res.rows[0].c)).toBe(1);
  });

  it('getPendingInbox returns pending rows ordered by id; markInboxDone removes them', async () => {
    await insertInboxMessage(baseMsg({ wa: 'a' }));
    await insertInboxMessage(baseMsg({ wa: 'b' }));
    const pending = await getPendingInbox(50);
    expect(pending.map((r) => r.wa_message_id)).toEqual(['a', 'b']);
    expect(typeof pending[0].from_me).toBe('boolean');
    await markInboxDone(pending[0].id);
    expect((await getPendingInbox(50)).map((r) => r.wa_message_id)).toEqual(['b']);
  });

  it('getRecentMessagesForChat returns chronological (oldest→newest), limited', async () => {
    await insertInboxMessage(baseMsg({ wa: 'old', ts: 100 }));
    await insertInboxMessage(baseMsg({ wa: 'mid', ts: 200 }));
    await insertInboxMessage(baseMsg({ wa: 'new', ts: 300 }));
    const recent = await getRecentMessagesForChat('c1', 2);
    expect(recent.map((r) => r.wa_message_id)).toEqual(['mid', 'new']);
  });
});

describe('processed_messages helpers', () => {
  it('hasProcessed false then true after markProcessed; markProcessed is idempotent', async () => {
    expect(await hasProcessed('x')).toBe(false);
    await markProcessed('x');
    await markProcessed('x');
    expect(await hasProcessed('x')).toBe(true);
  });
});

describe('follow_ups helpers', () => {
  it('insertFollowUp returns id and defaults status to pending', async () => {
    const id = await insertFollowUp({ chat_jid: 'c1', due_date: '2099-01-02', context: 'call' });
    expect(id).toBeGreaterThan(0);
    const fu = (await getPool().query('SELECT * FROM follow_ups WHERE id=$1', [id])).rows[0];
    expect(fu.status).toBe('pending');
    expect(fu.created_at).toBeGreaterThan(0);
    expect(fu.updated_at).toBe(fu.created_at);
  });

  it('getDueFollowUps returns pending/confirmed/snoozed with due_date<=date, ordered', async () => {
    await insertFollowUp({ chat_jid: 'c1', due_date: '2098-01-01', context: 'past-pending' });
    await insertFollowUp({ chat_jid: 'c1', due_date: '2099-01-01', context: 'future', status: 'confirmed' });
    await insertFollowUp({ chat_jid: 'c1', due_date: '2099-01-01', context: 'done-skip', status: 'done' });
    const due = await getDueFollowUps('2099-06-01');
    expect(due.map((f) => f.context)).toEqual(['past-pending', 'future']);
  });

  it('updateFollowUpStatus sets status, updated_at, and sent_at when provided', async () => {
    const id = await insertFollowUp({ chat_jid: 'c1', due_date: '2099-01-02', context: 'call' });
    await updateFollowUpStatus(id, 'sent', { sentAt: 12345 });
    const fu = (await getPool().query('SELECT * FROM follow_ups WHERE id=$1', [id])).rows[0];
    expect(fu.status).toBe('sent');
    expect(fu.sent_at).toBe(12345);
  });

  it('hasActiveFollowUp true for pending, false once cancelled/done', async () => {
    const id = await insertFollowUp({ chat_jid: 'c9', due_date: '2099-01-02', context: 'call' });
    expect(await hasActiveFollowUp('c9', '2099-01-02')).toBe(true);
    await updateFollowUpStatus(id, 'done');
    expect(await hasActiveFollowUp('c9', '2099-01-02')).toBe(false);
  });

  it('hasActiveFollowUp is time-aware: same date different time is not active', async () => {
    await insertFollowUp({ chat_jid: 'ct', due_date: '2099-01-02', due_time: '20:00', context: 'x' });
    expect(await hasActiveFollowUp('ct', '2099-01-02', '20:00')).toBe(true);
    expect(await hasActiveFollowUp('ct', '2099-01-02', '17:23')).toBe(false);
    expect(await hasActiveFollowUp('ct', '2099-01-02', null)).toBe(false);
  });
});

describe('events', () => {
  it('logEvent inserts a row with JSON payload', async () => {
    await logEvent('test_event', { a: 1 });
    const ev = (await getPool().query('SELECT * FROM events')).rows[0];
    expect(ev.type).toBe('test_event');
    expect(JSON.parse(ev.payload_json)).toEqual({ a: 1 });
  });
});
