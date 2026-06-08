import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// int8 (BIGINT) → JS number; our magnitudes (unix seconds, serial ids) are within Number range.
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

let pool: pg.Pool | undefined;
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.DATABASE_URL });
    // Neon suspends idle computes and drops idle connections; without this handler an
    // idle-client disconnect would surface as an unhandled error and crash the process.
    pool.on('error', (err) => logger.error({ err }, 'idle pg client error'));
  }
  return pool;
}
/** Test seam: inject a pg-mem (or other) pool. */
export function __setPoolForTests(p: pg.Pool): void { pool = p; }

export async function ensureSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS inbox (
      id SERIAL PRIMARY KEY,
      wa_message_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      contact_name TEXT,
      from_me BOOLEAN NOT NULL DEFAULT false,
      text TEXT NOT NULL,
      ts_unix BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','error')),
      created_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_wa_message_id ON inbox (wa_message_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox (status, id);
    CREATE INDEX IF NOT EXISTS idx_inbox_chat ON inbox (chat_jid, ts_unix);

    CREATE TABLE IF NOT EXISTS follow_ups (
      id SERIAL PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      contact_name TEXT,
      due_date TEXT NOT NULL,
      due_time TEXT,
      context TEXT NOT NULL,
      source_wa_message_id TEXT,
      confidence DOUBLE PRECISION,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','needs_review','confirmed','sent','done','cancelled','snoozed')),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      sent_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups (due_date, status);

    CREATE TABLE IF NOT EXISTS processed_messages (
      wa_message_id TEXT PRIMARY KEY,
      seen_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent')),
      created_at BIGINT NOT NULL,
      sent_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status, id);
  `);
}

const now = () => Math.floor(Date.now() / 1000);

export type InboxStatus = 'pending' | 'done' | 'error';
export type FollowUpStatus = 'pending'|'needs_review'|'confirmed'|'sent'|'done'|'cancelled'|'snoozed';

export interface InboxRow {
  id: number; wa_message_id: string; chat_jid: string; contact_name: string | null;
  from_me: boolean; text: string; ts_unix: number; status: InboxStatus; created_at: number;
}
export interface NewInboxMessage {
  wa_message_id: string; chat_jid: string; contact_name?: string | null;
  from_me: boolean; text: string; ts_unix: number;
}
export interface FollowUpRow {
  id: number; chat_jid: string; contact_name: string | null; due_date: string; due_time: string | null;
  context: string; source_wa_message_id: string | null; confidence: number | null;
  status: FollowUpStatus; created_at: number; updated_at: number; sent_at: number | null;
}
export interface NewFollowUp {
  chat_jid: string; contact_name?: string | null; due_date: string; due_time?: string | null;
  context: string; source_wa_message_id?: string | null; confidence?: number | null; status?: FollowUpStatus;
}

export async function insertInboxMessage(m: NewInboxMessage): Promise<number> {
  const ins = await getPool().query(
    `INSERT INTO inbox (wa_message_id, chat_jid, contact_name, from_me, text, ts_unix, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`,
    [m.wa_message_id, m.chat_jid, m.contact_name ?? null, m.from_me, m.text, m.ts_unix, now()],
  );
  if (ins.rows[0]) return ins.rows[0].id as number;
  const ex = await getPool().query(`SELECT id FROM inbox WHERE wa_message_id = $1`, [m.wa_message_id]);
  return (ex.rows[0]?.id as number) ?? 0;
}

export async function getPendingInbox(limit = 50): Promise<InboxRow[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM inbox WHERE status='pending' ORDER BY id ASC LIMIT $1`, [limit]);
  return rows as InboxRow[];
}

export async function markInboxDone(id: number, status: InboxStatus = 'done'): Promise<void> {
  await getPool().query(`UPDATE inbox SET status=$1 WHERE id=$2`, [status, id]);
}

export async function hasProcessed(waMessageId: string): Promise<boolean> {
  const { rows } = await getPool().query(`SELECT 1 FROM processed_messages WHERE wa_message_id=$1`, [waMessageId]);
  return rows.length > 0;
}

export async function markProcessed(waMessageId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO processed_messages (wa_message_id, seen_at) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [waMessageId, now()]);
}

export async function getRecentMessagesForChat(chatJid: string, limit = 20): Promise<InboxRow[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM inbox WHERE chat_jid=$1 ORDER BY ts_unix DESC, id DESC LIMIT $2`, [chatJid, limit]);
  return (rows as InboxRow[]).reverse();
}

export async function insertFollowUp(fu: NewFollowUp): Promise<number> {
  const t = now();
  const { rows } = await getPool().query(
    `INSERT INTO follow_ups
      (chat_jid, contact_name, due_date, due_time, context, source_wa_message_id, confidence, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
    [fu.chat_jid, fu.contact_name ?? null, fu.due_date, fu.due_time ?? null, fu.context,
     fu.source_wa_message_id ?? null, fu.confidence ?? null, fu.status ?? 'pending', t]);
  return rows[0].id as number;
}

export async function getDueFollowUps(dateStr: string): Promise<FollowUpRow[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM follow_ups WHERE due_date <= $1 AND status IN ('pending','confirmed','snoozed')
     ORDER BY due_date ASC, id ASC`, [dateStr]);
  return rows as FollowUpRow[];
}

export async function updateFollowUpStatus(
  id: number, status: FollowUpStatus, opts: { sentAt?: number } = {}): Promise<void> {
  await getPool().query(
    `UPDATE follow_ups SET status=$1, updated_at=$2, sent_at=COALESCE($3, sent_at) WHERE id=$4`,
    [status, now(), opts.sentAt ?? null, id]);
}

export async function hasActiveFollowUp(chatJid: string, dueDate: string, dueTime: string | null = null): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM follow_ups
       WHERE chat_jid=$1 AND due_date=$2 AND status NOT IN ('cancelled','done')
         AND (due_time = $3 OR (due_time IS NULL AND $3 IS NULL))
     LIMIT 1`,
    [chatJid, dueDate, dueTime]);
  return rows.length > 0;
}

export async function logEvent(type: string, payload: unknown): Promise<void> {
  await getPool().query(`INSERT INTO events (type, payload_json, created_at) VALUES ($1,$2,$3)`,
    [type, payload === undefined ? null : JSON.stringify(payload), now()]);
}

export interface OutboxRow { id: number; text: string; status: 'pending' | 'sent'; created_at: number; sent_at: number | null; }

export async function enqueueOutbox(text: string): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO outbox (text, status, created_at) VALUES ($1,'pending',$2) RETURNING id`, [text, now()]);
  return rows[0].id as number;
}
export async function getPendingOutbox(limit = 20): Promise<OutboxRow[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM outbox WHERE status='pending' ORDER BY id ASC LIMIT $1`, [limit]);
  return rows as OutboxRow[];
}
export async function markOutboxSent(id: number): Promise<void> {
  await getPool().query(`UPDATE outbox SET status='sent', sent_at=$1 WHERE id=$2`, [now(), id]);
}

export async function purgeOlderThan(cutoffUnix: number): Promise<{ inbox: number; processed: number; events: number; outbox: number }> {
  const pool = getPool();
  const inbox = (await pool.query(`DELETE FROM inbox WHERE ts_unix < $1`, [cutoffUnix])).rowCount ?? 0;
  const processed = (await pool.query(`DELETE FROM processed_messages WHERE seen_at < $1`, [cutoffUnix])).rowCount ?? 0;
  const events = (await pool.query(`DELETE FROM events WHERE created_at < $1`, [cutoffUnix])).rowCount ?? 0;
  const outbox = (await pool.query(`DELETE FROM outbox WHERE status='sent' AND sent_at < $1`, [cutoffUnix])).rowCount ?? 0;
  return { inbox, processed, events, outbox };
}
