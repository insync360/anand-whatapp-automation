/**
 * One-shot: connect with the existing linked session, run the reminder digest once,
 * deliver it to the user's own WhatsApp chat, then exit. Run this while the main
 * listener is STOPPED (only one session may use the auth state at a time).
 */
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { ensureSchema } from '../src/db.js';
import { makeDeliver } from '../src/notify.js';
import { runRemindersProd } from '../src/scheduler.js';

// Hard safety net: a one-shot must never hang (e.g. if the socket is replaced
// mid-send and sendMessage stalls). Always terminate.
setTimeout(() => { logger.error('remind:now timed out after 30s — exiting'); process.exit(1); }, 30_000);

await ensureSchema();
const { version } = await fetchLatestBaileysVersion();
const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);
const sock = makeWASocket({ version, auth: state, logger: logger.child({ module: 'baileys' }, { level: 'warn' }) });
sock.ev.on('creds.update', saveCreds);

let ran = false;
sock.ev.on('connection.update', async (u) => {
  if (u.connection === 'open' && !ran && sock.user?.id) {
    ran = true;
    const res = await runRemindersProd(makeDeliver(sock));
    logger.info(res, 'remind:now complete');
    setTimeout(() => process.exit(0), 1500); // allow the outbound send to flush
  }
});
