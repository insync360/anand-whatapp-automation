import type { OutboxRow } from './db.js';

export interface OutboxDeps {
  getPending: () => Promise<OutboxRow[]>;
  markSent: (id: number) => Promise<void>;
  deliver: (text: string) => Promise<void>;
}

/** Deliver each pending outbox row in order, marking it sent. Returns the count delivered. */
export async function drainOutbox(deps: OutboxDeps): Promise<number> {
  const rows = await deps.getPending();
  for (const r of rows) {
    await deps.deliver(r.text);
    await deps.markSent(r.id);
  }
  return rows.length;
}
