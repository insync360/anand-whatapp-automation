import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './logger.js';

export function ymdInTz(unixSeconds: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}

export function prettyInTz(unixSeconds: number, tz: string): string {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(unixSeconds * 1000));
  return `${s} (${tz})`;
}

export function todayInTz(tz: string): string {
  return ymdInTz(Math.floor(Date.now() / 1000), tz);
}

export function stripCodeFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}
