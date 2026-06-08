import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

/* ------------------------------------------------------------------ */
/* Connection + migrations                                            */
/* ------------------------------------------------------------------ */

mkdirSync(dirname(config.DB_PATH), { recursive: true });

export const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Idempotent schema. Safe to run on every boot.
 * Mirrors the data model in CLAUDE.md. A UNIQUE index on
 * inbox.wa_message_id makes ingestion idempotent (INSERT OR IGNORE).
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS inbox (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_message_id TEXT    NOT NULL,
    chat_jid      TEXT    NOT NULL,
    contact_name  TEXT,
    from_me       INTEGER NOT NULL DEFAULT 0,
    text          TEXT    NOT NULL,
    ts_unix       INTEGER NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'done', 'error')),
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_wa_message_id ON inbox (wa_message_id);
  CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox (status, id);
  CREATE INDEX IF NOT EXISTS idx_inbox_chat ON inbox (chat_jid, ts_unix);

  CREATE TABLE IF NOT EXISTS follow_ups (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid             TEXT    NOT NULL,
    contact_name         TEXT,
    due_date             TEXT    NOT NULL,            -- 'YYYY-MM-DD'
    due_time             TEXT,                        -- NULLABLE 'HH:MM'
    context              TEXT    NOT NULL,
    source_wa_message_id TEXT,
    confidence           REAL,
    status               TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN (
                             'pending', 'needs_review', 'confirmed',
                             'sent', 'done', 'cancelled', 'snoozed'
                           )),
    created_at           INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at           INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    sent_at              INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups (due_date, status);

  CREATE TABLE IF NOT EXISTS processed_messages (
    wa_message_id TEXT    PRIMARY KEY,
    seen_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT    NOT NULL,
    payload_json TEXT,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );
`);

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type InboxStatus = 'pending' | 'done' | 'error';

export type FollowUpStatus =
  | 'pending'
  | 'needs_review'
  | 'confirmed'
  | 'sent'
  | 'done'
  | 'cancelled'
  | 'snoozed';

export interface InboxRow {
  id: number;
  wa_message_id: string;
  chat_jid: string;
  contact_name: string | null;
  from_me: number; // 0 | 1
  text: string;
  ts_unix: number;
  status: InboxStatus;
  created_at: number;
}

export interface NewInboxMessage {
  wa_message_id: string;
  chat_jid: string;
  contact_name?: string | null;
  from_me: boolean;
  text: string;
  ts_unix: number;
}

export interface FollowUpRow {
  id: number;
  chat_jid: string;
  contact_name: string | null;
  due_date: string;
  due_time: string | null;
  context: string;
  source_wa_message_id: string | null;
  confidence: number | null;
  status: FollowUpStatus;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

export interface NewFollowUp {
  chat_jid: string;
  contact_name?: string | null;
  due_date: string;
  due_time?: string | null;
  context: string;
  source_wa_message_id?: string | null;
  confidence?: number | null;
  status?: FollowUpStatus;
}

/* ------------------------------------------------------------------ */
/* Prepared statements (created once)                                 */
/* ------------------------------------------------------------------ */

const stmtInsertInbox = db.prepare(
  `INSERT OR IGNORE INTO inbox
     (wa_message_id, chat_jid, contact_name, from_me, text, ts_unix)
   VALUES
     (@wa_message_id, @chat_jid, @contact_name, @from_me, @text, @ts_unix)`,
);
const stmtSelectInboxIdByWa = db.prepare(
  `SELECT id FROM inbox WHERE wa_message_id = ?`,
);
const stmtGetPendingInbox = db.prepare(
  `SELECT * FROM inbox WHERE status = 'pending' ORDER BY id ASC LIMIT ?`,
);
const stmtMarkInbox = db.prepare(
  `UPDATE inbox SET status = ? WHERE id = ?`,
);

const stmtHasProcessed = db.prepare(
  `SELECT 1 FROM processed_messages WHERE wa_message_id = ?`,
);
const stmtMarkProcessed = db.prepare(
  `INSERT OR IGNORE INTO processed_messages (wa_message_id) VALUES (?)`,
);

const stmtRecentForChat = db.prepare(
  `SELECT * FROM inbox WHERE chat_jid = ? ORDER BY ts_unix DESC, id DESC LIMIT ?`,
);

const stmtInsertFollowUp = db.prepare(
  `INSERT INTO follow_ups
     (chat_jid, contact_name, due_date, due_time, context,
      source_wa_message_id, confidence, status)
   VALUES
     (@chat_jid, @contact_name, @due_date, @due_time, @context,
      @source_wa_message_id, @confidence, @status)`,
);

const stmtGetDueFollowUps = db.prepare(
  `SELECT * FROM follow_ups
   WHERE due_date <= ?
     AND status IN ('pending', 'confirmed', 'snoozed')
   ORDER BY due_date ASC, id ASC`,
);

const stmtUpdateFollowUpStatus = db.prepare(
  `UPDATE follow_ups
     SET status = @status,
         updated_at = strftime('%s', 'now'),
         sent_at = COALESCE(@sent_at, sent_at)
   WHERE id = @id`,
);

const stmtLogEvent = db.prepare(
  `INSERT INTO events (type, payload_json) VALUES (?, ?)`,
);

/* ------------------------------------------------------------------ */
/* Helpers — Listener / ingestion                                    */
/* ------------------------------------------------------------------ */

/**
 * Insert a WhatsApp message into the inbox queue.
 * Idempotent on wa_message_id. Returns the row id (existing one on conflict).
 */
export function insertInboxMessage(msg: NewInboxMessage): number {
  const info = stmtInsertInbox.run({
    wa_message_id: msg.wa_message_id,
    chat_jid: msg.chat_jid,
    contact_name: msg.contact_name ?? null,
    from_me: msg.from_me ? 1 : 0,
    text: msg.text,
    ts_unix: msg.ts_unix,
  });
  if (info.changes > 0) return Number(info.lastInsertRowid);
  const existing = stmtSelectInboxIdByWa.get(msg.wa_message_id) as
    | { id: number }
    | undefined;
  return existing?.id ?? 0;
}

/* ------------------------------------------------------------------ */
/* Helpers — Extraction worker                                       */
/* ------------------------------------------------------------------ */

export function getPendingInbox(limit = 50): InboxRow[] {
  return stmtGetPendingInbox.all(limit) as InboxRow[];
}

export function markInboxDone(id: number, status: InboxStatus = 'done'): void {
  stmtMarkInbox.run(status, id);
}

export function hasProcessed(waMessageId: string): boolean {
  return stmtHasProcessed.get(waMessageId) !== undefined;
}

export function markProcessed(waMessageId: string): void {
  stmtMarkProcessed.run(waMessageId);
}

/**
 * Recent messages for a chat, returned in chronological (oldest → newest)
 * order — the short rolling window the LLM uses for context.
 */
export function getRecentMessagesForChat(
  chatJid: string,
  limit = 20,
): InboxRow[] {
  const rows = stmtRecentForChat.all(chatJid, limit) as InboxRow[];
  return rows.reverse();
}

export function insertFollowUp(fu: NewFollowUp): number {
  const info = stmtInsertFollowUp.run({
    chat_jid: fu.chat_jid,
    contact_name: fu.contact_name ?? null,
    due_date: fu.due_date,
    due_time: fu.due_time ?? null,
    context: fu.context,
    source_wa_message_id: fu.source_wa_message_id ?? null,
    confidence: fu.confidence ?? null,
    status: fu.status ?? 'pending',
  });
  return Number(info.lastInsertRowid);
}

/* ------------------------------------------------------------------ */
/* Helpers — Scheduler                                               */
/* ------------------------------------------------------------------ */

/** Follow-ups due on or before `dateStr` ('YYYY-MM-DD') still awaiting delivery. */
export function getDueFollowUps(dateStr: string): FollowUpRow[] {
  return stmtGetDueFollowUps.all(dateStr) as FollowUpRow[];
}

export function updateFollowUpStatus(
  id: number,
  status: FollowUpStatus,
  opts: { sentAt?: number } = {},
): void {
  stmtUpdateFollowUpStatus.run({
    id,
    status,
    sent_at: opts.sentAt ?? null,
  });
}

/* ------------------------------------------------------------------ */
/* Helpers — Misc                                                    */
/* ------------------------------------------------------------------ */

export function logEvent(type: string, payload: unknown): void {
  stmtLogEvent.run(type, payload === undefined ? null : JSON.stringify(payload));
}
