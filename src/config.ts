import 'dotenv/config';
import { z } from 'zod';

/**
 * Single source of truth for runtime configuration.
 * Loads .env (via dotenv/config) and validates with zod at startup.
 * Fails fast with a clear message if required vars are missing/invalid.
 */
const ConfigSchema = z.object({
  // Hard-required: the only var that must be present this phase.
  ANTHROPIC_API_KEY: z
    .string({ required_error: 'ANTHROPIC_API_KEY is required' })
    .min(1, 'ANTHROPIC_API_KEY must not be empty'),

  MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
  TIMEZONE: z.string().min(1).default('Asia/Kolkata'),
  REMINDER_HOUR: z.coerce.number().int().min(0).max(23).default(8),

  // Telegram delivery — required by the scheduler phase, optional for now.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  DATABASE_URL: z.string().url('DATABASE_URL must be a valid Postgres connection string'),
  AUTH_DIR: z.string().min(1).default('./auth_info'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.string().default('development'),
});

export type Config = z.infer<typeof ConfigSchema>;

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Use console here: the logger may not be safe to import before config is valid.
  console.error(`\nInvalid configuration. Check your .env (see .env.example):\n${issues}\n`);
  process.exit(1);
}

export const config: Config = parsed.data;
