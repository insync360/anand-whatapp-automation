const DAY = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const parseUTC = (ymd: string): number => Date.parse(`${ymd}T00:00:00Z`);
const mondayStart = (ms: number): number => {
  const dow = new Date(ms).getUTCDay(); // 0=Sun..6=Sat
  return ms - ((dow + 6) % 7) * DAY;   // back up to Monday
};

export function relativeDay(today: string, dueDate: string): string {
  const t = parseUTC(today);
  const d = parseUTC(dueDate);
  const days = Math.round((d - t) / DAY);
  if (days < 0) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  const weeks = Math.round((mondayStart(d) - mondayStart(t)) / (7 * DAY));
  const weekday = WEEKDAYS[new Date(d).getUTCDay()];
  if (weeks === 0) return `this ${weekday}`;
  if (weeks === 1) return `next ${weekday}`;
  return `in ${days} days`;
}

const prettyDate = (ymd: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(parseUTC(ymd));

export interface AckInput {
  userName: string; contactName: string | null; dueDate: string; dueTime: string | null;
  context: string; today: string; status: 'pending' | 'needs_review';
}

export function buildAck(i: AckInput): string {
  const contact = i.contactName ?? 'your contact';
  const time = i.dueTime ? ` at *${i.dueTime}*` : '';
  const rel = relativeDay(i.today, i.dueDate);
  const relSuffix = rel ? ` (${rel})` : '';
  const body =
    `👤 Contact: *${contact}*\n` +
    `📅 Due: *${prettyDate(i.dueDate)}*${time}${relSuffix}\n` +
    `📝 ${i.context}`;
  if (i.status === 'needs_review') {
    return `🤔 *Possible follow-up — saved for review*\n\nHi ${i.userName} 👋 I wasn't fully sure, but it sounded like:\n${body}`;
  }
  return `✅ *Follow-up recorded*\n\nHi ${i.userName} 👋\n${body}`;
}
