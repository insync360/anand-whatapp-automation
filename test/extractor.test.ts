import { describe, it, expect } from 'vitest';
import { ymdInTz, prettyInTz, todayInTz, stripCodeFences } from '../src/extractor.js';

describe('date/tz helpers', () => {
  // 2026-06-08T20:00:00Z == 2026-06-09 01:30 IST (Asia/Kolkata, +5:30)
  const unix = Math.floor(Date.parse('2026-06-08T20:00:00Z') / 1000);

  it('ymdInTz returns the local YYYY-MM-DD in the timezone', () => {
    expect(ymdInTz(unix, 'Asia/Kolkata')).toBe('2026-06-09');
    expect(ymdInTz(unix, 'UTC')).toBe('2026-06-08');
  });

  it('prettyInTz includes weekday and timezone label', () => {
    const s = prettyInTz(unix, 'Asia/Kolkata');
    expect(s).toContain('Asia/Kolkata');
    expect(s).toMatch(/Tuesday/); // 2026-06-09 is a Tuesday
  });

  it('todayInTz returns an ISO date string', () => {
    expect(todayInTz('Asia/Kolkata')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('stripCodeFences', () => {
  it('removes ```json fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('removes bare ``` fences', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('leaves unfenced text unchanged', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});
