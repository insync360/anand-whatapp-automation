import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import {
  getPendingInbox, getRecentMessagesForChat, insertFollowUp,
  markInboxDone, logEvent, hasActiveFollowUp, ensureSchema, enqueueOutbox, type InboxRow,
} from './db.js';
import { extractFollowUp, todayInTz, type ExtractInput, type FollowUpResult } from './extractor.js';
import { buildAck } from './ack.js';
import { config } from './config.js';
import { startCleanupCron, runCleanup } from './cleanup.js';

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 4000);
const CONFIDENCE_THRESHOLD = 0.6;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60000;

type ExtractFn = (input: ExtractInput) => Promise<FollowUpResult | null>;

export async function processRow(row: InboxRow, extract: ExtractFn = extractFollowUp): Promise<'done' | 'pending'> {
  const thread = (await getRecentMessagesForChat(row.chat_jid, 6)).map((r) => ({ fromMe: r.from_me, text: r.text }));
  let result: FollowUpResult | null;
  try {
    result = await extract({ thread, contactName: row.contact_name, messageTimestampUnix: row.ts_unix });
  } catch (err) {
    logger.error({ err, inboxId: row.id }, 'extraction failed; leaving row pending');
    return 'pending';
  }
  if (result) {
    if (await hasActiveFollowUp(row.chat_jid, result.date, result.time)) {
      logger.info({ chatJid: row.chat_jid, dueDate: result.date }, 'duplicate follow-up skipped');
    } else {
      const status = result.confidence >= CONFIDENCE_THRESHOLD ? 'pending' : 'needs_review';
      const id = await insertFollowUp({
        chat_jid: row.chat_jid, contact_name: row.contact_name,
        due_date: result.date, due_time: result.time, context: result.context,
        source_wa_message_id: row.wa_message_id, confidence: result.confidence, status,
      });
      await logEvent('followup_captured', { followUpId: id, chatJid: row.chat_jid, dueDate: result.date, confidence: result.confidence, status });
      logger.info({ followUpId: id, dueDate: result.date, status }, 'follow-up captured');
      await enqueueOutbox(
        buildAck({
          userName: config.USER_NAME,
          contactName: row.contact_name,
          dueDate: result.date,
          dueTime: result.time,
          context: result.context,
          today: todayInTz(config.TIMEZONE),
          status,
        }),
      );
    }
  }
  await markInboxDone(row.id);
  return 'done';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runLoop(): Promise<void> {
  let failures = 0;
  logger.info({ pollMs: POLL_MS }, 'extraction worker started');
  for (;;) {
    let hadError = false;
    try {
      for (const row of await getPendingInbox(20)) {
        if ((await processRow(row)) === 'pending') { hadError = true; break; }
      }
    } catch (err) {
      logger.error({ err }, 'unexpected worker loop error; backing off');
      hadError = true;
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
  void ensureSchema()
    .then(() => {
      startCleanupCron();
      void runCleanup().catch((err) => logger.error({ err }, 'startup cleanup failed'));
      return runLoop();
    })
    .catch((err) => { logger.error({ err }, 'failed to start worker'); process.exit(1); });
}
