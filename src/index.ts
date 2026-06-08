/**
 * Phase 1 boot check.
 * Validates config, opens the DB (creating folder + running migrations),
 * logs "ready", and exits cleanly. No listener / worker / scheduler yet.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import './db.js'; // side effect: open DB + run idempotent migrations

logger.info(
  {
    model: config.MODEL,
    timezone: config.TIMEZONE,
    reminderHour: config.REMINDER_HOUR,
    dbPath: config.DB_PATH,
  },
  'ready',
);

process.exit(0);
