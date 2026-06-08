# "Only Message Me" Guardrail (Design Spec)

**Date:** 2026-06-08  **Status:** Approved (brainstorming)

## Context & goal
Every outbound WhatsApp message (reminders + acks) goes through one function, `makeDeliver` in
`src/notify.ts` — the only caller of `sock.sendMessage`. Today it sends to whatever JID the listener
passes (which is the user's own number), but that isn't enforced at the choke point. Harden it so it
is **structurally impossible** to message anyone but the linked account's owner, with a configured
number allowlist as a second layer.

## Approved decisions
- `makeDeliver` **derives the destination itself** from `sock.user.id` (callers cannot pass a target).
- A configured **`SELF_NUMBER`** (bare digits) allowlist: refuse to send unless the linked account's
  number equals `SELF_NUMBER`. A mismatch **silently refuses + logs an `error`** (never crashes).

## Changes
### `src/notify.ts` — `makeDeliver(sock?)` (drop the `selfJid` param)
```ts
import { jidNormalizedUser, type WASocket } from '@whiskeysockets/baileys';
import { config } from './config.js';
// returns (text) => Promise<void>; never throws
// - console.log(text) always
// - if !sock -> return (console-only)
// - ownId = sock.user?.id; if missing -> warn + return
// - ownJid = jidNormalizedUser(ownId); ownNumber = ownJid.split('@')[0]
// - if config.SELF_NUMBER && ownNumber !== config.SELF_NUMBER -> logger.error("REFUSING...") + return
// - sent = await sock.sendMessage(ownJid, { text }); if sent.key.id -> markProcessed(id)
```
Destination is ALWAYS `ownJid` (the linked account). No path sends to a caller-supplied JID.

### `src/config.ts` + `.env.example`
Add `SELF_NUMBER: z.string().regex(/^\d{8,15}$/).optional()`. `.env.example`: `SELF_NUMBER=` (with a
comment that it's your number in digits, e.g. 918460548054). When unset, behavior falls back to
self-derived only (still safe).

### Callers (mechanical) — `src/listener.ts`, `scripts/remind-now.ts`
Change `makeDeliver(sock, selfJid)` → `makeDeliver(sock)` (scheduler-deliver + outbox-poller in the
listener; the one call in remind-now). `liveSelfJid` stays for the connected-guard/logging.

### Tests — `test/setup.ts` + `test/notify.test.ts`
- `test/setup.ts`: `process.env.SELF_NUMBER ??= '15550001111';` (a fixed test number).
- `test/notify.test.ts` (rewritten for the new signature, pg-mem for `markProcessed`):
  - matches SELF_NUMBER → sends to the socket's own derived JID + `markProcessed`;
  - **mismatching** account (different `sock.user.id`) → **no `sendMessage` call** (refused);
  - no socket → console-only no-op; never throws; always `console.log`s.

## Guarantees
All outbound WhatsApp messages can only reach the linked account's own number, and (with
`SELF_NUMBER` set) only if that number is yours. Contacts/clients can never be messaged. Capture
remains read-only.

## Deploy
Set `SELF_NUMBER=918460548054` in the VM `/opt/wa-app/.env`; ship via CI/CD (push to `main`).

## Files
Modified: `src/notify.ts`, `src/config.ts`, `.env.example`, `src/listener.ts`,
`scripts/remind-now.ts`, `test/setup.ts`, `test/notify.test.ts`.
