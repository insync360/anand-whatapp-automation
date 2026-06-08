import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ensureSchema, getPool, insertInboxMessage, insertFollowUp } from '../src/db.js';
import { runCleanup } from '../src/cleanup.js';

const NOW = 2_000_000_000;
const OLD = NOW - 40 * 86_400;
const RECENT = NOW - 5 * 86_400;

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => {
  for (const t of ['inbox', 'follow_ups', 'processed_messages', 'events', 'outbox']) {
    await getPool().query(`DELETE FROM ${t}`);
  }
});

describe('runCleanup', () => {
  it('deletes rows older than retention, keeps recent rows and all follow_ups', async () => {
    await insertInboxMessage({ wa_message_id: 'old', chat_jid: 'c', from_me: false, text: 'old', ts_unix: OLD });
    await insertInboxMessage({ wa_message_id: 'new', chat_jid: 'c', from_me: false, text: 'new', ts_unix: RECENT });
    await getPool().query(`INSERT INTO processed_messages (wa_message_id, seen_at) VALUES ('p_old',$1),('p_new',$2)`, [OLD, RECENT]);
    await getPool().query(`INSERT INTO events (type, payload_json, created_at) VALUES ('e_old',null,$1),('e_new',null,$2)`, [OLD, RECENT]);
    await getPool().query(`INSERT INTO outbox (text,status,created_at,sent_at) VALUES ('o_old_sent','sent',$1,$1),('o_old_pending','pending',$1,null),('o_new_sent','sent',$2,$2)`, [OLD, RECENT]);
    await insertFollowUp({ chat_jid: 'c', due_date: '2020-01-01', context: 'keep me' });

    const counts = await runCleanup(30, NOW);
    expect(counts).toEqual({ inbox: 1, processed: 1, events: 1, outbox: 1 });

    expect((await getPool().query(`SELECT wa_message_id FROM inbox`)).rows.map((r) => r.wa_message_id)).toEqual(['new']);
    expect((await getPool().query(`SELECT count(*)::int c FROM processed_messages`)).rows[0].c).toBe(1);
    expect((await getPool().query(`SELECT count(*)::int c FROM events WHERE type LIKE 'e_%'`)).rows[0].c).toBe(1);
    expect((await getPool().query(`SELECT count(*)::int c FROM outbox`)).rows[0].c).toBe(2);
    expect((await getPool().query(`SELECT count(*)::int c FROM follow_ups`)).rows[0].c).toBe(1);
  });
});
