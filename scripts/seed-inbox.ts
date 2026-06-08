import { insertInboxMessage, ensureSchema } from '../src/db.js';
import { logger } from '../src/logger.js';

const now = Math.floor(Date.now() / 1000);
const samples = [
  { wa_message_id: `seed-clear-${now}`, chat_jid: 'seed-asha@s.whatsapp.net', contact_name: 'Asha',
    from_me: false, text: "Perfect, let's connect on Tuesday at 4pm to finalize the contract.", ts_unix: now },
  { wa_message_id: `seed-hinglish-${now}`, chat_jid: 'seed-ravi@s.whatsapp.net', contact_name: 'Ravi',
    from_me: false, text: 'thik hai, agle hafte call karte hain', ts_unix: now },
  { wa_message_id: `seed-chitchat-${now}`, chat_jid: 'seed-meera@s.whatsapp.net', contact_name: 'Meera',
    from_me: false, text: 'Haha 😂 that movie was hilarious, loved the ending!', ts_unix: now },
];

await ensureSchema();
for (const m of samples) await insertInboxMessage(m);
logger.info(`seeded ${samples.length} inbox messages`);
