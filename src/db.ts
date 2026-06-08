import pg from 'pg';
import { config } from './config.js';

// int8 (BIGINT) → JS number; our magnitudes (unix seconds, serial ids) are within Number range.
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

let pool: pg.Pool | undefined;
export function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: config.DATABASE_URL });
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
  `);
}
