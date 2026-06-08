import * as cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { purgeOlderThan, logEvent } from './db.js';

export async function runCleanup(
  retentionDays = config.RETENTION_DAYS,
  nowUnix = Math.floor(Date.now() / 1000),
): Promise<{ inbox: number; processed: number; events: number; outbox: number }> {
  const cutoff = nowUnix - retentionDays * 86_400;
  const counts = await purgeOlderThan(cutoff);
  await logEvent('cleanup_ran', { retentionDays, cutoff, ...counts });
  logger.info({ retentionDays, ...counts }, 'data retention cleanup ran');
  return counts;
}

export function startCleanupCron(): void {
  const expr = `0 ${config.CLEANUP_HOUR} * * *`;
  cron.schedule(
    expr,
    () => { void runCleanup().catch((err) => logger.error({ err }, 'cleanup failed')); },
    { timezone: config.TIMEZONE },
  );
  logger.info({ cron: expr, tz: config.TIMEZONE, retentionDays: config.RETENTION_DAYS }, 'cleanup scheduler started');
}
