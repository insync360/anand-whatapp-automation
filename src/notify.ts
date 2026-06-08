import type { WASocket } from '@whiskeysockets/baileys';
import { logger } from './logger.js';
import { markProcessed } from './db.js';

/**
 * Build a reminder deliverer. Always console.logs the text. If a live socket + the
 * user's own JID are provided, it ALSO sends the text to the user's own WhatsApp chat
 * and marks the echoed message id processed (so the listener's dedup ignores our own
 * reminder, preventing a feedback loop). Never throws.
 */
export function makeDeliver(sock?: WASocket, selfJid?: string) {
  return async (text: string): Promise<void> => {
    console.log(text);
    try {
      if (sock && selfJid) {
        const sent = await sock.sendMessage(selfJid, { text });
        const id = sent?.key?.id ?? undefined;
        if (id) await markProcessed(id);
      }
    } catch (err) {
      logger.error({ err }, 'reminder delivery via WhatsApp failed');
    }
  };
}
