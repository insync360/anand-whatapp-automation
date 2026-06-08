import { describe, it, expect } from 'vitest';
import { relativeDay, buildAck } from '../src/ack.js';

describe('relativeDay', () => {
  const today = '2026-06-08'; // Monday
  it('today / tomorrow', () => {
    expect(relativeDay(today, '2026-06-08')).toBe('today');
    expect(relativeDay(today, '2026-06-09')).toBe('tomorrow');
  });
  it('this <weekday> within the same week', () => {
    expect(relativeDay(today, '2026-06-12')).toBe('this Friday');
  });
  it('next <weekday> the following week', () => {
    expect(relativeDay(today, '2026-06-16')).toBe('next Tuesday');
  });
  it('in N days when further out', () => {
    expect(relativeDay(today, '2026-06-30')).toBe('in 22 days');
  });
});

describe('buildAck', () => {
  const base = {
    userName: 'Anand', contactName: 'Ajeet', dueDate: '2026-06-16', dueTime: '16:00',
    context: 'get back about the proposal', today: '2026-06-08', status: 'pending' as const,
  };
  it('pending: recorded card with contact, date, relative, time, context', () => {
    const s = buildAck(base);
    expect(s).toContain('✅ *Follow-up recorded*');
    expect(s).toContain('Hi Anand');
    expect(s).toContain('Contact: *Ajeet*');
    expect(s).toContain('*Tue, 16 Jun 2026*');
    expect(s).toContain('at *16:00*');
    expect(s).toContain('(next Tuesday)');
    expect(s).toContain('📝 get back about the proposal');
  });
  it('needs_review: softer header and intro', () => {
    const s = buildAck({ ...base, status: 'needs_review' });
    expect(s).toContain('🤔 *Possible follow-up — saved for review*');
    expect(s).toContain("wasn't fully sure");
  });
  it('omits time when null and falls back for null contact', () => {
    const s = buildAck({ ...base, dueTime: null, contactName: null });
    expect(s).not.toContain(' at *');
    expect(s).toContain('Contact: *your contact*');
  });
});
