/**
 * Phase 1 boot check (now on Neon Postgres).
 * Validates config, ensures the schema exists, logs "ready", exits cleanly.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { ensureSchema } from './db.js';

await ensureSchema();

logger.info(
  {
    model: config.MODEL,
    timezone: config.TIMEZONE,
    reminderHour: config.REMINDER_HOUR,
    databaseUrlSet: Boolean(config.DATABASE_URL),
  },
  'ready',
);

process.exit(0);
