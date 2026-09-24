import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { durationMs, normalizePhrase, parseModelReply, resolveSleepUntil, weekdayInPhrase } from './sleep';

// The phrase and reply parsers decide when a card runs again. Wrong unit math
// or a missed reply shape silently parks a card at the wrong time, so these
// pure functions are worth pinning; the model call itself is verified live and
// is not testable here.

describe('durationMs', () => {
  it('reads the units a user types', () => {
    expect(durationMs('45 minutes')).toBe(45 * 60_000);
    expect(durationMs('45 min')).toBe(45 * 60_000);
    expect(durationMs('30m')).toBe(30 * 60_000);
    expect(durationMs('2 hours')).toBe(7_200_000);
    expect(durationMs('3 hr')).toBe(10_800_000);
    expect(durationMs('2 days')).toBe(172_800_000);
    expect(durationMs('1 week')).toBe(604_800_000);
    expect(durationMs('90 seconds')).toBe(90_000);
  });

  it('reads fractional amounts', () => {
    expect(durationMs('1.5 hours')).toBe(5_400_000);
    expect(durationMs('0.5 days')).toBe(43_200_000);
  });

  it('returns null for anything that is not a bare duration', () => {
    expect(durationMs('tomorrow at 8am')).toBeNull();
    expect(durationMs('whenever')).toBeNull();
    expect(durationMs('1.5')).toBeNull();
    expect(durationMs('0 minutes')).toBeNull();
    expect(durationMs('10 fortnights')).toBeNull();
  });

  it('reads the phrasings a user adds around a duration', () => {
    expect(durationMs('in 45 minutes')).toBe(2_700_000);
    expect(durationMs('2 days from now')).toBe(172_800_000);
    expect(durationMs('in 2 weeks')).toBe(1_209_600_000);
  });
});

describe('normalizePhrase', () => {
  it('strips filler words so the host can resolve the phrase', () => {
    expect(normalizePhrase('next friday at 10am')).toBe('next friday 10am');
    expect(normalizePhrase('until tuesday at 5pm')).toBe('tuesday 5pm');
    expect(normalizePhrase('tomorrow at 8am')).toBe('tomorrow 8am');
  });

  it('turns a day period into a clock time', () => {
    expect(normalizePhrase('saturday morning')).toBe('saturday 09:00');
    expect(normalizePhrase('tomorrow evening')).toBe('tomorrow 19:00');
  });

  it('handles tonight and relative-day phrasings', () => {
    expect(normalizePhrase('tonight at 9pm')).toBe('9pm');
    expect(normalizePhrase('in 3 days at 9am')).toBe('+3 days 9am');
  });

  it('refuses phrases that name no day or time', () => {
    expect(normalizePhrase('whenever')).toBeNull();
    expect(normalizePhrase('banana')).toBeNull();
    expect(normalizePhrase('soon')).toBeNull();
  });
});

describe('parseModelReply', () => {
  it('reads both reply shapes', () => {
    expect(parseModelReply('WAIT: +12 hours')).toEqual({ kind: 'wait', phrase: '+12 hours' });
    expect(parseModelReply('WAKE: 2026-09-29 17:00')).toEqual({ kind: 'wake', phrase: '2026-09-29 17:00' });
  });

  it('strips backticks and quotes the model adds', () => {
    expect(parseModelReply('WAKE: `2026-09-29 17:00`')).toEqual({ kind: 'wake', phrase: '2026-09-29 17:00' });
    expect(parseModelReply('WAIT: "+1 hour 30 minutes"')).toEqual({ kind: 'wait', phrase: '+1 hour 30 minutes' });
  });

  it('accepts a bare date phrase on its own line', () => {
    expect(parseModelReply('tuesday 17:00')).toEqual({ kind: 'wake', phrase: 'tuesday 17:00' });
    expect(parseModelReply('+90 minutes')).toEqual({ kind: 'wait', phrase: '+90 minutes' });
  });

  it('returns null when there is no readable phrase', () => {
    expect(parseModelReply('I cannot compute that.')).toBeNull();
    expect(parseModelReply('')).toBeNull();
  });
});

describe('weekdayInPhrase', () => {
  it('finds full names and abbreviations', () => {
    expect(weekdayInPhrase('tuesday at 5pm')).toBe(2);
    expect(weekdayInPhrase('next fri 10:00')).toBe(5);
    expect(weekdayInPhrase('sunday 09:00')).toBe(0);
  });

  it('returns null when no weekday is named', () => {
    expect(weekdayInPhrase('12 hours')).toBeNull();
    expect(weekdayInPhrase('tomorrow at 8am')).toBeNull();
  });
});

describe('resolveSleepUntil', () => {
  const now = Date.UTC(2026, 8, 24, 20, 0, 0);

  it('adds durations to now without a model call', async () => {
    await expect(resolveSleepUntil('1.5 hours', now)).resolves.toBe(now + 5_400_000);
    await expect(resolveSleepUntil('2 days', now)).resolves.toBe(now + 172_800_000);
  });

  it('refuses empty, past, and oversized phrases', async () => {
    await expect(resolveSleepUntil('', now)).rejects.toThrow(/needs a time/);
    await expect(resolveSleepUntil('yesterday', now)).rejects.toThrow(/past/);
    // A bare duration takes the fast path, so this needs no model call.
    await expect(resolveSleepUntil('400 days', now)).rejects.toThrow(/more than a year/);
  });

  // A weekday named in the phrase must be resolved by the host. When this went
  // to the model it answered a Tuesday for "next friday at 10am", which the
  // weekday check then rejected — the phrase failed outright.
  it('resolves weekday phrases exactly as the host date does', async () => {
    const want = Number(String(execFileSync('date', ['-d', 'next friday 10am', '+%s'])).trim()) * 1000;
    await expect(resolveSleepUntil('next friday at 10am')).resolves.toBe(want);
  });
});
