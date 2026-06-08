import { describe, it, expect } from 'vitest';
import { config } from '../src/config.js';

describe('config defaults', () => {
  it('OUTBOX_POLL_MS defaults to 5000 (number)', () => {
    expect(config.OUTBOX_POLL_MS).toBe(5000);
    expect(typeof config.OUTBOX_POLL_MS).toBe('number');
  });
});
