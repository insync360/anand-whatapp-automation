import pino from 'pino';
import { config } from './config.js';

/**
 * Shared pino logger.
 * Uses pino-pretty for human-readable output outside production.
 */
const isProd = config.NODE_ENV === 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
});
