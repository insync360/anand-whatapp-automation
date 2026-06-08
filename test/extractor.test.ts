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
  it('removes fences with any language tag', () => {
    expect(stripCodeFences('```text\n{"a":1}\n```')).toBe('{"a":1}');
  });
});

import { extractFollowUp, ExtractionSchema } from '../src/extractor.js';

function fakeClient(text: string) {
  return { messages: { create: async () => ({ content: [{ type: 'text', text }] }) } } as any;
}
const baseInput = {
  thread: [{ fromMe: false, text: 'Shall we talk next week?' }],
  contactName: 'Asha',
  messageTimestampUnix: Math.floor(Date.parse('2026-06-08T06:00:00Z') / 1000),
};

describe('extractFollowUp', () => {
  it('returns a result for a concrete future follow-up', async () => {
    const r = await extractFollowUp(baseInput, fakeClient(
      '{"hasFollowUp":true,"date":"2099-06-16","time":"16:00","context":"call about proposal","confidence":0.9}',
    ));
    expect(r).toEqual({ date: '2099-06-16', time: '16:00', context: 'call about proposal', confidence: 0.9 });
  });

  it('returns null when hasFollowUp is false', async () => {
    const r = await extractFollowUp(baseInput, fakeClient('{"hasFollowUp":false,"date":null,"time":null,"context":"","confidence":0.1}'));
    expect(r).toBeNull();
  });

  it('returns null when the date is in the past', async () => {
    const r = await extractFollowUp(baseInput, fakeClient('{"hasFollowUp":true,"date":"2000-01-01","time":null,"context":"x","confidence":0.9}'));
    expect(r).toBeNull();
  });

  it('strips code fences before parsing', async () => {
    const r = await extractFollowUp(baseInput, fakeClient('```json\n{"hasFollowUp":true,"date":"2099-01-02","time":null,"context":"x","confidence":0.7}\n```'));
    expect(r?.date).toBe('2099-01-02');
  });

  it('returns null on malformed JSON (does not throw)', async () => {
    const r = await extractFollowUp(baseInput, fakeClient('not json at all'));
    expect(r).toBeNull();
  });

  it('propagates API/network errors (so the worker can retry)', async () => {
    const throwing = { messages: { create: async () => { throw new Error('rate limit'); } } } as any;
    await expect(extractFollowUp(baseInput, throwing)).rejects.toThrow('rate limit');
  });
});
