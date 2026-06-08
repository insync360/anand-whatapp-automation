import { jidNormalizedUser, type WASocket } from '@whiskeysockets/baileys';
import { logger } from './logger.js';
import { markProcessed } from './db.js';
import { config } from './config.js';

/**
 * Build a reminder/ack deliverer. Always console.logs. With a live socket it sends ONLY to the
 * linked account's own number (derived from the socket — callers cannot target anyone else), and
 * only if that number matches SELF_NUMBER when configured. Marks the echo processed. Never throws.
 */
export function makeDeliver(sock?: WASocket) {
  return async (text: string): Promise<void> => {
    console.log(text);
    try {
      if (!sock) return;
      const ownId = sock.user?.id;
      if (!ownId) { logger.warn('makeDeliver: socket has no user id; skipping WhatsApp send'); return; }
      const ownJid = jidNormalizedUser(ownId);
      const ownNumber = ownJid.split('@')[0];
      if (config.SELF_NUMBER && ownNumber !== config.SELF_NUMBER) {
        logger.error({ ownNumber, expected: config.SELF_NUMBER },
          'REFUSING WhatsApp send: linked account is not the configured SELF_NUMBER (only the owner may be messaged)');
        return;
      }
      const sent = await sock.sendMessage(ownJid, { text });
      const id = sent?.key?.id;
      if (id) await markProcessed(id);
    } catch (err) {
      logger.error({ err }, 'reminder delivery via WhatsApp failed');
    }
  };
}
