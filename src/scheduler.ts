import * as cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { todayInTz } from './extractor.js';
import { getDueFollowUps, updateFollowUpStatus, logEvent, type FollowUpRow } from './db.js';

export interface ReminderDeps {
  today: string;
  now: number;
  getDue: (today: string) => Promise<FollowUpRow[]>;
  markSent: (id: number, sentAt: number) => Promise<void>;
  deliver: (text: string) => Promise<void>;
  logEvent: (type: string, payload: unknown) => Promise<void>;
}

export function buildDigest(today: string, due: FollowUpRow[]): string {
  const sorted = [...due].sort(
    (a, b) => a.due_date.localeCompare(b.due_date) || (a.due_time ?? '99:99').localeCompare(b.due_time ?? '99:99'),
  );
  const lines = sorted.map((f) => {
    const contact = f.contact_name ?? 'Unknown';
    const time = f.due_time ? ` ${f.due_time}` : '';
    const overdue = f.due_date < today ? ` (was due ${f.due_date})` : '';
    return `• ${contact}${time} — ${f.context}${overdue}`;
  });
  return `📌 Follow-ups for ${today} (${due.length}):\n${lines.join('\n')}`;
}

export async function runReminders(deps: ReminderDeps): Promise<{ count: number; delivered: boolean }> {
  const due = await deps.getDue(deps.today);
  if (due.length === 0) { logger.info('no follow-ups due'); return { count: 0, delivered: false }; }
  await deps.deliver(buildDigest(deps.today, due));
  for (const f of due) {
    await deps.markSent(f.id, deps.now);
    await deps.logEvent('reminder_sent', { followUpId: f.id, dueDate: f.due_date });
  }
  logger.info({ count: due.length }, 'reminders delivered');
  return { count: due.length, delivered: true };
}

/** Production deps wiring: due = pending/confirmed only (per spec; snoozed excluded). */
export function runRemindersProd(deliver: (text: string) => Promise<void>) {
  return runReminders({
    today: todayInTz(config.TIMEZONE),
    now: Math.floor(Date.now() / 1000),
    getDue: async (t) => (await getDueFollowUps(t)).filter((f) => f.status === 'pending' || f.status === 'confirmed'),
    markSent: (id, sentAt) => updateFollowUpStatus(id, 'sent', { sentAt }),
    deliver,
    logEvent,
  });
}

export function startScheduler(deliver: (text: string) => Promise<void>): void {
  const expr = `0 ${config.REMINDER_HOUR} * * *`;
  cron.schedule(
    expr,
    () => { void runRemindersProd(deliver).catch((err) => logger.error({ err }, 'reminder run failed')); },
    { timezone: config.TIMEZONE },
  );
  logger.info({ cron: expr, tz: config.TIMEZONE }, 'reminder scheduler started');
}
