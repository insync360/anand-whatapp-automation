import { describe, it, expect } from 'vitest';
import { buildDigest, runReminders } from '../src/scheduler.js';
import type { FollowUpRow } from '../src/db.js';

const fu = (over: Partial<FollowUpRow>): FollowUpRow => ({
  id: 1, chat_jid: 'c', contact_name: 'Asha', due_date: '2026-06-08', due_time: null,
  context: 'call', source_wa_message_id: null, confidence: 0.9, status: 'pending',
  created_at: 0, updated_at: 0, sent_at: null, ...over,
});

describe('buildDigest', () => {
  it('header has the date and count; lists each item', () => {
    const s = buildDigest('2026-06-08', [fu({ id: 1, contact_name: 'Asha', context: 'call', due_time: '16:00' })]);
    expect(s).toContain('📌 Follow-ups for 2026-06-08 (1):');
    expect(s).toContain('• Asha 16:00 — call');
  });
  it('annotates overdue items and omits time when null', () => {
    const s = buildDigest('2026-06-08', [fu({ contact_name: 'Ravi', context: 'proposal', due_date: '2026-06-05', due_time: null })]);
    expect(s).toContain('• Ravi — proposal (was due 2026-06-05)');
  });
  it('sorts by date then time', () => {
    const lines = buildDigest('2026-06-09', [
      fu({ id: 1, contact_name: 'B', due_date: '2026-06-09', due_time: '15:00', context: 'b' }),
      fu({ id: 2, contact_name: 'A', due_date: '2026-06-08', due_time: null, context: 'a' }),
      fu({ id: 3, contact_name: 'C', due_date: '2026-06-09', due_time: '09:00', context: 'c' }),
    ]).split('\n').slice(1);
    expect(lines.map((l) => l[2])).toEqual(['A', 'C', 'B']); // char after "• "
  });
});

describe('runReminders', () => {
  it('delivers digest, marks each sent, logs events', async () => {
    const due = [fu({ id: 7, due_date: '2026-06-08' }), fu({ id: 8, due_date: '2026-06-08' })];
    const delivered: string[] = []; const sent: Array<[number, number]> = []; const events: any[] = [];
    const res = await runReminders({
      today: '2026-06-08', now: 1000,
      getDue: async () => due,
      markSent: async (id, at) => { sent.push([id, at]); },
      deliver: async (t) => { delivered.push(t); },
      logEvent: async (type, p) => { events.push([type, p]); },
    });
    expect(res).toEqual({ count: 2, delivered: true });
    expect(delivered).toHaveLength(1);
    expect(sent).toEqual([[7, 1000], [8, 1000]]);
    expect(events.map((e) => e[0])).toEqual(['reminder_sent', 'reminder_sent']);
  });
  it('does nothing when none are due', async () => {
    const delivered: string[] = [];
    const res = await runReminders({
      today: '2026-06-08', now: 1000, getDue: async () => [],
      markSent: async () => {}, deliver: async (t) => { delivered.push(t); }, logEvent: async () => {},
    });
    expect(res).toEqual({ count: 0, delivered: false });
    expect(delivered).toHaveLength(0);
  });
});
