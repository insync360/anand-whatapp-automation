import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  db, getPendingInbox, getRecentMessagesForChat, insertFollowUp,
  markInboxDone, logEvent, type InboxRow,
} from './db.js';
import { extractFollowUp, type ExtractInput, type FollowUpResult } from './extractor.js';

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 4000);
const CONFIDENCE_THRESHOLD = 0.6;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60000;

const stmtActiveFollowUp = db.prepare(
  `SELECT 1 FROM follow_ups WHERE chat_jid = ? AND due_date = ? AND status NOT IN ('cancelled','done') LIMIT 1`,
);
export function hasActiveFollowUp(chatJid: string, dueDate: string): boolean {
  return stmtActiveFollowUp.get(chatJid, dueDate) !== undefined;
}

type ExtractFn = (input: ExtractInput) => Promise<FollowUpResult | null>;

export async function processRow(row: InboxRow, extract: ExtractFn = extractFollowUp): Promise<'done' | 'pending'> {
  const thread = getRecentMessagesForChat(row.chat_jid, 6).map((r) => ({ fromMe: !!r.from_me, text: r.text }));
  let result: FollowUpResult | null;
  try {
    result = await extract({ thread, contactName: row.contact_name, messageTimestampUnix: row.ts_unix });
  } catch (err) {
    logger.error({ err, inboxId: row.id }, 'extraction failed; leaving row pending');
    return 'pending';
  }
  if (result) {
    if (hasActiveFollowUp(row.chat_jid, result.date)) {
      logger.info({ chatJid: row.chat_jid, dueDate: result.date }, 'duplicate follow-up skipped');
    } else {
      const status = result.confidence >= CONFIDENCE_THRESHOLD ? 'pending' : 'needs_review';
      const id = insertFollowUp({
        chat_jid: row.chat_jid, contact_name: row.contact_name,
        due_date: result.date, due_time: result.time, context: result.context,
        source_wa_message_id: row.wa_message_id, confidence: result.confidence, status,
      });
      logEvent('followup_captured', { followUpId: id, chatJid: row.chat_jid, dueDate: result.date, confidence: result.confidence, status });
      logger.info({ followUpId: id, dueDate: result.date, status }, 'follow-up captured');
    }
  }
  markInboxDone(row.id);
  return 'done';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runLoop(): Promise<void> {
  let failures = 0;
  logger.info({ pollMs: POLL_MS }, 'extraction worker started');
  for (;;) {
    let hadError = false;
    for (const row of getPendingInbox(20)) {
      if ((await processRow(row)) === 'pending') { hadError = true; break; }
    }
    if (hadError) {
      failures += 1;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
      logger.warn({ failures, delayMs: delay }, 'backing off after extraction error');
      await sleep(delay);
    } else {
      failures = 0;
      await sleep(POLL_MS);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.on('SIGINT', () => { logger.info('worker shutting down'); process.exit(0); });
  process.on('SIGTERM', () => { logger.info('worker shutting down'); process.exit(0); });
  void runLoop();
}
