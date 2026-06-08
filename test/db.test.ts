import { describe, it, expect, beforeAll } from 'vitest';
import { ensureSchema, getPool } from '../src/db.js';

describe('ensureSchema', () => {
  beforeAll(async () => { await ensureSchema(); });
  it('creates the four tables', async () => {
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
    );
    const names = rows.map((r: any) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(['events', 'follow_ups', 'inbox', 'processed_messages']));
  });
});
