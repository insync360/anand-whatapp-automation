/**
 * Phase 2 — WhatsApp listener (capture read-only + daily reminder digest).
 *
 * Links as a WhatsApp device, captures incoming/outgoing 1:1 text messages,
 * and pushes them into the `inbox` queue. Message capture is strictly read-only:
 * no typing, presence, receipts, or reactions are used. The ONE exception is the
 * daily reminder digest, which is sent to the user's OWN number (self-chat) only.
 * No messages are ever sent to contacts.
 */
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageContent,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';

import { config } from './config.js';
import { logger } from './logger.js';
import { hasProcessed, insertInboxMessage, markProcessed, ensureSchema, getPendingOutbox, markOutboxSent } from './db.js';
import { drainOutbox } from './outbox.js';
import { startScheduler } from './scheduler.js';
import { makeDeliver } from './notify.js';

// Quiet child logger for Baileys' own internals so it doesn't drown our logs.
const waLogger = logger.child({ module: 'baileys' }, { level: 'warn' });

// Chat-partner display names, learned from pushName on their incoming messages.
const contactNames = new Map<string, string>();

// Exponential-backoff reconnect state.
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
let reconnectAttempts = 0;
let connecting = false;
let schedulerStarted = false;
let outboxStarted = false;
// The Baileys socket is recreated on every reconnect, so the reminder deliverer must
// read the LIVE socket at fire time rather than capture one at scheduler-start.
let liveSock: ReturnType<typeof makeWASocket> | undefined;
let liveSelfJid: string | undefined;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Pull the human text out of the various message shapes we care about. */
function extractText(message: WAMessageContent | null | undefined): string | undefined {
  if (!message) return undefined;
  const text =
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    undefined;
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

/** Baileys timestamps may be number | Long | undefined. Normalize to unix seconds. */
function tsToUnix(ts: WAMessage['messageTimestamp']): number {
  if (typeof ts === 'number') return ts;
  if (ts && typeof (ts as { toNumber?: () => number }).toNumber === 'function') {
    return (ts as { toNumber: () => number }).toNumber();
  }
  return Math.floor(Date.now() / 1000);
}

/** True for jids that are NOT a 1:1 personal chat (groups, broadcasts, etc.). */
function isNonPersonalChat(jid: string): boolean {
  return (
    jid === 'status@broadcast' ||
    jid.endsWith('@g.us') ||
    jid.endsWith('@broadcast') ||
    jid.endsWith('@newsletter')
  );
}

/* ------------------------------------------------------------------ */
/* Message ingestion                                                  */
/* ------------------------------------------------------------------ */

async function handleMessage(msg: WAMessage): Promise<void> {
  const jid = msg.key.remoteJid;
  if (!jid || isNonPersonalChat(jid)) return;

  const fromMe = !!msg.key.fromMe;

  const text = extractText(msg.message);
  if (!text) return;

  // Learn the contact's display name from their own messages.
  if (!fromMe && msg.pushName) contactNames.set(jid, msg.pushName);
  const contactName = contactNames.get(jid) ?? msg.pushName ?? null;

  const waId = msg.key.id;
  if (!waId) return;

  // Dedup against the durable ledger.
  if (await hasProcessed(waId)) return;

  const tsUnix = tsToUnix(msg.messageTimestamp);

  await insertInboxMessage({
    wa_message_id: waId,
    chat_jid: jid,
    contact_name: contactName,
    from_me: fromMe,
    text,
    ts_unix: tsUnix,
  });
  await markProcessed(waId);

  logger.info(
    {
      jid,
      fromMe,
      contact: contactName,
      preview: text.length > 80 ? `${text.slice(0, 80)}…` : text,
    },
    'captured message',
  );
}

/* ------------------------------------------------------------------ */
/* Connection                                                         */
/* ------------------------------------------------------------------ */

async function connect(): Promise<void> {
  if (connecting) return;
  connecting = true;

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: waLogger,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        logger.info('Scan this QR with WhatsApp > Settings > Linked Devices > Link a Device:');
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        logger.info('linked / listening');
        if (sock.user?.id) {
          // Refresh the live socket on every (re)connect.
          liveSock = sock;
          liveSelfJid = jidNormalizedUser(sock.user.id);
          // Connect-time guardrail check so a SELF_NUMBER misconfig is caught NOW, not at first send.
          const linkedNumber = liveSelfJid.split('@')[0];
          if (!config.SELF_NUMBER) {
            logger.warn({ linkedNumber }, 'SELF_NUMBER is not set — delivering to the linked self-chat (wrong-account check disabled)');
          } else if (linkedNumber !== config.SELF_NUMBER) {
            logger.error(
              { linkedNumber, expected: config.SELF_NUMBER },
              'SELF_NUMBER MISMATCH — all WhatsApp sends will be REFUSED. Set SELF_NUMBER in .env to the linked number (or unset it) and restart.',
            );
          } else {
            logger.info({ number: linkedNumber }, 'delivery armed: linked account matches SELF_NUMBER');
          }
          if (!schedulerStarted) {
            // Deliver resolves the live socket at fire time, not at scheduler-start.
            startScheduler((text) => makeDeliver(liveSock)(text));
            schedulerStarted = true;
            logger.info({ selfJid: liveSelfJid }, 'reminder delivery enabled (WhatsApp self-message)');
          }
          if (!outboxStarted) {
            setInterval(() => {
              const s = liveSock; const j = liveSelfJid;
              if (!s || !j) return; // only drain while connected
              void drainOutbox({
                getPending: () => getPendingOutbox(20),
                markSent: markOutboxSent,
                deliver: makeDeliver(s),
              }).catch((err) => logger.error({ err }, 'outbox drain failed'));
            }, config.OUTBOX_POLL_MS);
            outboxStarted = true;
            logger.info({ pollMs: config.OUTBOX_POLL_MS }, 'outbox poller started');
          }
        }
      }

      if (connection === 'close') {
        connecting = false;
        liveSock = undefined; // degrade reminders to console-only until the next 'open'
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          logger.fatal(
            `Logged out by WhatsApp. Delete the auth folder (${config.AUTH_DIR}) and re-run to re-link.`,
          );
          return; // do NOT reconnect
        }

        const delay = Math.min(
          BACKOFF_BASE_MS * 2 ** reconnectAttempts,
          BACKOFF_MAX_MS,
        );
        reconnectAttempts += 1;
        logger.warn(
          { statusCode, attempt: reconnectAttempts, delayMs: delay },
          'connection closed, reconnecting',
        );
        setTimeout(() => {
          void connect();
        }, delay);
      }
    });

    // The ONLY ingestion path. 'notify' = live messages; ignore history sync.
    sock.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages) {
        try {
          await handleMessage(msg);
        } catch (err) {
          logger.error({ err, key: msg.key }, 'failed to process message');
        }
      }
    });
  } catch (err) {
    connecting = false;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** reconnectAttempts, BACKOFF_MAX_MS);
    reconnectAttempts += 1;
    logger.error({ err, attempt: reconnectAttempts, delayMs: delay }, 'connect failed, retrying');
    setTimeout(() => {
      void connect();
    }, delay);
  }
}

logger.info('starting WhatsApp listener (read-only)…');
void ensureSchema()
  .then(() => connect())
  .catch((err) => { logger.error({ err }, 'failed to start listener'); process.exit(1); });
