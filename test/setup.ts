import { newDb } from 'pg-mem';

process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.DATABASE_URL ??= 'postgres://test/test';
process.env.TIMEZONE ??= 'Asia/Kolkata';
process.env.LOG_LEVEL ??= 'silent';

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const { __setPoolForTests } = await import('../src/db.js');
__setPoolForTests(new Pool());
