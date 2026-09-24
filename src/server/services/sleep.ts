/* oxlint-disable orchestrel/log-before-early-return -- pure phrase/reply resolvers: guard returns are unmatched input, not swallowed errors */
/* /sleep resolution: turn a human time phrase into the epoch when a card may
 * run again.
 *
 * Pure durations ("12 hours", "1.5 days") are exact arithmetic here. Everything
 * else — "tomorrow at 8am", "until tuesday at 5pm" — goes to a local model via
 * the sleepResolver config, but the model never does the date math: it only
 * names the time (WAIT: +12 hours or WAKE: 2026-09-29 17:00) and GNU date on
 * this host turns that into an epoch. A weekday named in the phrase is
 * cross-checked against the date the model picked, because the small model
 * lands one day early on weekday phrases; one corrective retry follows.
 *
 * The waker moves sleeping cards back to running when their time arrives. It
 * re-reads the DB on every tick, so a missed fire (restart, offline node) is
 * caught by the next tick and the DB stays the only source of truth.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { LessThanOrEqual } from 'typeorm';
import { Card } from '../models/Card';
import { messageBus, type MessageBus } from '../bus';
import { loadConfig } from '../../shared/config';

const execFileAsync = promisify(execFile);

/** A phrase the resolver cannot turn into a time. The message reaches the card. */
export class SleepResolutionError extends Error {}

const MIN_AHEAD_MS = 30_000;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

// ── Pure durations ───────────────────────────────────────────────────────────

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/;

/** Milliseconds named by a bare duration ("45 minutes", "in 2 days"), or null. */
export function durationMs(phrase: string): number | null {
  // "in 45 minutes" and "2 days from now" name the same wait as "45 minutes".
  const bare = phrase
    .trim()
    .replace(/^in\s+/i, '')
    .replace(/\s+from\s+(now|today)$/i, '')
    .trim();
  const m = DURATION_RE.exec(bare);
  if (!m) return null;
  const unit = unitMs(m[2]);
  if (unit === null) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * unit;
}

function unitMs(raw: string): number | null {
  // "secs" → "sec", "minutes" → "minute", and a lone "s" stays "s".
  const key = raw.toLowerCase().replace(/s$/, '') || 's';
  if (key === 's' || key === 'sec' || key === 'second') return 1_000;
  if (key === 'm' || key === 'min' || key === 'minute') return 60_000;
  if (key === 'h' || key === 'hr' || key === 'hour') return 3_600_000;
  if (key === 'd' || key === 'day') return 86_400_000;
  if (key === 'w' || key === 'wk' || key === 'week') return 604_800_000;
  return null;
}

// ── Weekday phrases ──────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEKDAY_RE = /\b(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b/i;

/** Weekday the phrase names (0 = Sunday), or null when it names none. */
export function weekdayInPhrase(phrase: string): number | null {
  const m = WEEKDAY_RE.exec(phrase);
  if (!m) return null;
  const day = DAY_INDEX[m[1].toLowerCase()];
  return day ?? null;
}

// ── Phrase normalisation ─────────────────────────────────────────────────────

// Conventional hour for a bare day period, so "saturday morning" and the model
// prompt agree on one answer.
const PERIOD_TIMES: Record<string, string> = {
  morning: '09:00',
  noon: '12:00',
  midday: '12:00',
  afternoon: '15:00',
  evening: '19:00',
  night: '21:00',
};

// A phrase only goes to `date` on its own when it names a day or a clock time;
// anything else is the model's job. Without this guard, filler-stripped garbage
// could resolve to some arbitrary date.
const DATEABLE_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next\s+(week|month)|\d{1,2}(?::\d{2})?\s*(am|pm)|\d{1,2}:\d{2})\b/;

/**
 * Human phrase → the GNU date phrase it means, or null when the mapping is not
 * unambiguous. "next friday at 10am" becomes "next friday 10am" so the host
 * resolves the weekday; the model would otherwise do that arithmetic in its
 * head and land on the wrong day.
 */
export function normalizePhrase(phrase: string): string | null {
  let s = phrase
    .toLowerCase()
    .replace(/[.,!?]/g, ' ')
    .replace(/\b(at|on|the|until|by|for)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // "in 3 days 9am" is a GNU relative offset: "+3 days 9am".
  s = s.replace(/^in\s+(\d)/, '+$1');

  const period = /\b(morning|noon|midday|afternoon|evening|night)\b/.exec(s);
  if (period && !/\d{1,2}(?::\d{2})?\s*(am|pm)\b|\b\d{1,2}:\d{2}\b/.test(s)) {
    s = s.replace(period[0], PERIOD_TIMES[period[1]]);
  }
  // "tonight 21:00" is not a date phrase; tonight is today's clock time.
  s = s.replace(/\btonight\b/g, ' ').replace(/\s+/g, ' ').trim();

  if (!DATEABLE_RE.test(s)) return null;
  return s;
}

/** Epoch (ms) GNU date reads from a phrase, or null when it cannot. */
async function tryDate(phrase: string): Promise<number | null> {
  if (!usablePhrase(phrase)) return null;
  try {
    const { stdout } = await execFileAsync('date', ['-d', phrase, '+%s'], { timeout: 5_000 });
    const secs = Number(stdout.trim());
    return Number.isFinite(secs) ? secs * 1000 : null;
  } catch (err) {
    console.log(`[sleep] date rejected phrase "${phrase}":`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Model reply → phrase → epoch ─────────────────────────────────────────────

export interface ModelTimeReply {
  kind: 'wait' | 'wake';
  /** The GNU date -d phrase the model wrote. */
  phrase: string;
}

/** Read a WAIT:/WAKE: line, or fall back to a bare date phrase. */
export function parseModelReply(reply: string): ModelTimeReply | null {
  const wait = /WAIT:\s*([^\n]+)/i.exec(reply);
  if (wait) return { kind: 'wait', phrase: wait[1].trim().replace(/^["'`]|["'`]$/g, '') };
  const wake = /WAKE:\s*([^\n]+)/i.exec(reply);
  if (wake) return { kind: 'wake', phrase: wake[1].trim().replace(/^["'`]|["'`]$/g, '') };
  // Some runs answer with the phrase alone. Accept a first line that looks like
  // one (a relative offset, a clock time, a date, or a day name).
  const line = reply.split('\n').map((l) => l.trim().replace(/^["'`]|["'`]$/g, '')).find(Boolean);
  if (line && line.length <= 60 && /^(\+|\d|mon|tue|wed|thu|fri|sat|sun|tomorrow|next |this |today|noon|midnight)/i.test(line)) {
    return { kind: /^\+/.test(line) ? 'wait' : 'wake', phrase: line };
  }
  return null;
}

function usablePhrase(phrase: string): boolean {
  return phrase.length > 0 && phrase.length <= 60 && !/[\n`]/.test(phrase);
}

function assertAhead(until: number, now: number, phrase: string): void {
  if (until <= now + MIN_AHEAD_MS) throw new SleepResolutionError(`"${phrase}" is not a future time`);
  if (until > now + MAX_AHEAD_MS) throw new SleepResolutionError(`"${phrase}" is more than a year away`);
}

/** Local time from the same host that runs the date commands. */
async function nowLabel(): Promise<string> {
  const { stdout } = await execFileAsync('date', ['+%Y-%m-%d %H:%M:%S %Z'], { timeout: 5_000 });
  return stdout.trim();
}

function systemPrompt(phrase: string, now: string): string {
  return [
    `You compute wake times for a card scheduler. Current local time: ${now}`,
    'GNU date -d accepts exactly these forms:',
    '  +10 minutes | +2 hours | +90 minutes | +2 days | +1 hour 30 minutes | tomorrow 08:00 | tuesday 17:00 | 21:00 | next friday 10:00',
    'Times are 24-hour HH:MM. Never use the word at in a date phrase. Never use the sleep command.',
    'Expand fractional amounts: 1.5 hours is +1 hour 30 minutes.',
    'For a named day, use the next such day after the current local time.',
    `The card resumes when: "${phrase}"`,
    'Reply with EXACTLY one line, nothing else:',
    '- If the phrase is a wait from now (minutes, hours, days): WAIT: +<amount>',
    '- If the phrase names a day or clock time: WAKE: <YYYY-MM-DD HH:MM>',
  ].join('\n');
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface SleepEndpoint {
  url: string;
  apiKey?: string;
  model: string;
}

/**
 * The model that names /sleep times, read from the `sleepResolver` block in
 * config.yaml (the symlink to orcd.yaml). The block names a provider + model
 * alias, so the API url and key come from the provider entry and are never
 * stated twice or hardcoded here.
 */
function loadSleeper(): SleepEndpoint {
  const cfg = loadConfig();
  const block = cfg.sleepResolver;
  if (!block) throw new SleepResolutionError('No sleepResolver is set in config.yaml');
  const provider = cfg.providers[block.provider];
  if (!provider) throw new SleepResolutionError(`sleepResolver provider "${block.provider}" is not in config.yaml`);
  const modelDef = provider.models[block.model];
  if (!modelDef) {
    throw new SleepResolutionError(`sleepResolver model "${block.model}" is not in provider "${block.provider}"`);
  }
  const base = (provider.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new SleepResolutionError(`sleepResolver provider "${block.provider}" has no baseUrl`);
  return {
    // Existing provider baseUrls are either a bare host:port (ray) or already
    // versioned (deepseek); accept both.
    url: /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`,
    apiKey: provider.apiKey ?? provider.authToken,
    model: modelDef.modelID,
  };
}

async function askModel(endpoint: SleepEndpoint, messages: ChatMessage[]): Promise<string> {
  const res = await fetch(endpoint.url, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      'Content-Type': 'application/json',
      ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: endpoint.model,
      messages,
      stream: false,
      temperature: 0,
      // Generous: a reasoning model spends its budget thinking first, and an
      // answer cut off at the cap comes back as empty content.
      max_tokens: 512,
      // Always off. Naming a time needs no chain of thought, and for the
      // reasoning models on the gateway (gemma4) leaving it on costs 5-17s and
      // an empty answer when the budget runs out mid-thought. Templates that
      // have no thinking pass ignore this.
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok) throw new SleepResolutionError(`Sleep time lookup failed (${res.status})`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new SleepResolutionError('Sleep time lookup returned no answer');
  return content;
}

function localStamp(epoch: number): string {
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Epoch (ms) when a card that used /sleep may run again. */
export async function resolveSleepUntil(phrase: string, now = Date.now()): Promise<number> {
  const clean = phrase.trim();
  if (!clean) throw new SleepResolutionError('/sleep needs a time, for example "/sleep 12 hours"');
  // A past day can only produce a nonsense wake time; refuse before the model
  // turns "yesterday" into some future date of its own choosing.
  if (/\b(yesterday|last\s+(mon|tue|wed|thu|fri|sat|sun))/i.test(clean)) {
    throw new SleepResolutionError(`"${clean}" is in the past`);
  }

  const ms = durationMs(clean);
  if (ms !== null) {
    const until = now + ms;
    assertAhead(until, now, clean);
    return until;
  }

  // Phrase the host can parse itself ("next friday at 10am", "until tuesday
  // at 5pm") never reaches the model: it resolves the weekday outright, while a
  // small model answers that arithmetic with the wrong day. An unresolvable or
  // already-past phrase falls through to the model instead of failing here.
  const normalized = normalizePhrase(clean);
  if (normalized) {
    const until = await tryDate(normalized);
    if (until !== null && until > now + MIN_AHEAD_MS && until <= now + MAX_AHEAD_MS) return until;
  }

  const endpoint = loadSleeper();
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(clean, await nowLabel()) },
    { role: 'user', content: `Phrase: ${clean}` },
  ];

  let reply = await askModel(endpoint, messages);
  let parsed = parseModelReply(reply);
  if (!parsed) throw new SleepResolutionError(`Could not understand the sleep time "${clean}"`);

  let until = await tryDate(parsed.phrase);
  if (until === null) throw new SleepResolutionError(`Could not read a time from "${parsed.phrase}"`);
  const asked = weekdayInPhrase(clean);
  if (asked !== null && new Date(until).getDay() !== asked) {
    // Small models land one day early on weekday phrases. Name the weekday they
    // picked, ask once more, and refuse rather than park the card on that date.
    messages.push({ role: 'assistant', content: reply });
    messages.push({
      role: 'user',
      content:
        `Your answer ${localStamp(until)} is a ${DAY_NAMES[new Date(until).getDay()]}. ` +
        `The card must resume on ${DAY_NAMES[asked]}. Reply with the corrected line only.`,
    });
    reply = await askModel(endpoint, messages);
    parsed = parseModelReply(reply);
    if (!parsed) throw new SleepResolutionError(`Could not understand the sleep time "${clean}"`);
    const retry = await tryDate(parsed.phrase);
    if (retry === null || new Date(retry).getDay() !== asked) {
      const landed = retry === null ? `an unreadable time ("${parsed.phrase}")` : `${localStamp(retry)} (${DAY_NAMES[new Date(retry).getDay()]})`;
      throw new SleepResolutionError(
        `Could not agree a ${DAY_NAMES[asked]}: "${clean}" resolved to ${landed}. ` +
          `Try "/sleep <hours>" or an explicit date.`,
      );
    }
    until = retry;
  }
  assertAhead(until, now, clean);
  return until;
}

// ── Waker ────────────────────────────────────────────────────────────────────

let wakerStarted = false;

/** Start the wake timer and the stale-sleep cleanup. Safe to call twice. */
export function startSleepWaker(bus: MessageBus = messageBus, intervalMs = 15_000): void {
  if (wakerStarted) return;
  wakerStarted = true;

  // A card dragged out of ready by hand (or done/archived) must forget its
  // pending wake, or returning it to ready later would fire the stale time.
  bus.subscribe('board:changed', async (payload) => {
    const { card, newColumn } = payload as { card: Card | null; newColumn: string | null };
    if (!card || newColumn === 'ready' || card.sleepUntil == null) return;
    const fresh = await Card.findOneBy({ id: card.id });
    if (!fresh || fresh.sleepUntil == null || fresh.column === 'ready') return;
    fresh.sleepUntil = null;
    fresh.updatedAt = new Date().toISOString();
    await fresh.save();
    console.log(`[sleep] card ${card.id} left ready: dropped its pending wake`);
  });

  const tick = () => void wakeDueCards().catch((err) => console.error('[sleep] wake tick failed:', err));
  setInterval(tick, intervalMs);
  setTimeout(tick, 3_000);
  console.log(`[sleep] waker started (every ${Math.round(intervalMs / 1000)}s)`);
}

/** Move every sleeping card whose time has arrived back to running. */
export async function wakeDueCards(now = Date.now()): Promise<number> {
  const due = await Card.find({ where: { column: 'ready', sleepUntil: LessThanOrEqual(now) } });
  for (const card of due) {
    // Moving to running fires board:changed, which starts the session.
    card.column = 'running';
    card.sleepUntil = null;
    card.updatedAt = new Date().toISOString();
    await card.save();
    console.log(`[sleep] card ${card.id} woke: ready → running`);
  }
  return due.length;
}
