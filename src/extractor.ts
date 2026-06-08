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
  return s.replace(/^\s*```(?:\w+)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

export const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export const ExtractionSchema = z.object({
  hasFollowUp: z.boolean(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  context: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface ThreadMessage { fromMe: boolean; text: string; }
export interface ExtractInput {
  thread: ThreadMessage[];
  contactName: string | null;
  messageTimestampUnix: number;
}
export interface FollowUpResult { date: string; time: string | null; context: string; confidence: number; }

const SYSTEM_PROMPT = `You read a short 1:1 chat conversation and decide whether the two people have agreed on, or clearly implied, a concrete NEXT POINT OF CONTACT (a call, meeting, message, or follow-up) by EITHER person.

Rules:
- Understand ANY language, including Hindi, English, and romanized/transliterated mixes (Hinglish). "kal" = tomorrow, "parso" = day after, "agle hafte" = next week, "agle mahine" = next month.
- Resolve every relative date ("Tuesday", "next week", "after Diwali", "kal") to an ABSOLUTE calendar date in YYYY-MM-DD, computed from the provided "Current message time" and timezone. If a weekday is named, pick the next future occurrence.
- Only set hasFollowUp=true when the plan is reasonably concrete (a resolvable day). Vague intentions ("let's catch up sometime", "I'll see") => hasFollowUp=false.
- time is 24h HH:MM if an explicit time is given, else null.
- context: a short (<=120 char) one-line summary of what the contact is, e.g. "call to finalize contract".
- confidence: 0..1, how sure you are this is a real, dated follow-up.

Respond with ONLY a JSON object, no prose, no code fences:
{"hasFollowUp": boolean, "date": "YYYY-MM-DD"|null, "time": "HH:MM"|null, "context": string, "confidence": number}

Examples:
Conversation: Me: Can we finalize the contract? / Asha: Sure, let's connect Tuesday at 4pm.
(message time Saturday 2026-06-06) -> {"hasFollowUp":true,"date":"2026-06-09","time":"16:00","context":"call to finalize the contract","confidence":0.95}

Conversation: Ravi: thik hai, agle hafte call karte hain
(message time Monday 2026-06-08) -> {"hasFollowUp":true,"date":"2026-06-15","time":null,"context":"call next week","confidence":0.7}

Conversation: Me: haha that movie was great
(message time 2026-06-08) -> {"hasFollowUp":false,"date":null,"time":null,"context":"","confidence":0.95}`;

export async function extractFollowUp(
  input: ExtractInput,
  client: Pick<Anthropic, 'messages'> = anthropic,
): Promise<FollowUpResult | null> {
  const { thread, contactName, messageTimestampUnix } = input;
  const tz = config.TIMEZONE;
  const who = contactName ?? 'Contact';
  const convo = thread.map((m) => `${m.fromMe ? 'Me' : who}: ${m.text}`).join('\n');
  const userContent =
    `Timezone: ${tz}\n` +
    `Current message time: ${prettyInTz(messageTimestampUnix, tz)}\n\n` +
    `Conversation (most recent last):\n${convo}`;

  const resp = await client.messages.create({
    model: config.MODEL,
    max_tokens: 300,
    // Prompt caching is wired up, but it only engages once the cached prefix exceeds
    // Haiku's ~2048-token minimum. Our SYSTEM_PROMPT is ~455 tokens, so today this
    // cache_control is a harmless no-op (the API ignores it, no error). Real cost
    // control here comes from Haiku + max_tokens + the 6-message window. The marker
    // stays so caching kicks in automatically if the prompt/examples grow later.
    // `as any`: SDK 0.32 types cache_control only under beta.messages, but the stable
    // endpoint accepts it at runtime.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }] as any,
    messages: [{ role: 'user', content: userContent }],
  });

  let parsed: Extraction;
  try {
    const block = resp.content.find((b) => b.type === 'text');
    const raw = block && 'text' in block ? block.text : '';
    parsed = ExtractionSchema.parse(JSON.parse(stripCodeFences(raw)));
  } catch (err) {
    logger.warn({ err }, 'extractFollowUp: could not parse/validate LLM output');
    return null;
  }

  if (!parsed.hasFollowUp || !parsed.date) return null;
  if (parsed.date < todayInTz(tz)) return null;
  return { date: parsed.date, time: parsed.time, context: parsed.context, confidence: parsed.confidence };
}
