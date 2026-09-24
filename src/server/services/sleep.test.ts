import { execFileSync } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import { durationMs, normalizePhrase, parseModelReply, resolveSleepUntil, sleepFallbackPrompt, splitSleepArgument, weekdayInPhrase } from './sleep';

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
    expect(normalizePhrase('midnight')).toBe('00:00');
    expect(normalizePhrase('tonight')).toBe('21:00');
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

describe('splitSleepArgument', () => {
  it('splits the wake prompt off the time phrase', () => {
    expect(splitSleepArgument('until friday at 1am then check the status of whatever')).toEqual({
      phrase: 'until friday at 1am',
      prompt: 'check the status of whatever',
    });
  });

  it('keeps a later "then" inside the prompt', () => {
    expect(splitSleepArgument('2 hours then run tests then report')).toEqual({
      phrase: '2 hours',
      prompt: 'run tests then report',
    });
  });

  it('takes a prompt written on the next line when there is no "then"', () => {
    expect(splitSleepArgument('2 hours', 'check the deploy\nand report')).toEqual({
      phrase: '2 hours',
      prompt: 'check the deploy\nand report',
    });
  });

  it('reports no prompt for a plain sleep', () => {
    expect(splitSleepArgument('2 hours')).toEqual({ phrase: '2 hours', prompt: null });
    expect(splitSleepArgument('2 hours then')).toEqual({ phrase: '2 hours', prompt: null });
    expect(splitSleepArgument('2 hours', '   ')).toEqual({ phrase: '2 hours', prompt: null });
  });
});

describe('sleepFallbackPrompt', () => {
  it('names the deferred mechanism instead of leaving the agent to block', () => {
    const text = sleepFallbackPrompt('end of the month', 'check the deploy');
    expect(text).toContain('could not work out the time "end of the month"');
    expect(text).toContain("Agent tool's schedule parameter");
    expect(text).toContain('check the deploy');
    expect(text).toContain('do not block with a long sleep');
  });

  it('still says something useful without a task after "then"', () => {
    expect(sleepFallbackPrompt('end of the month', null)).toContain('then continue with this card.');
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

  // A bare clock time or day period names no day, so one that has already
  // passed means the next one. These phrases used to reach the model, which
  // meant "/sleep until morning" failed outright whenever the resolver model was
  // down — for a time the host can work out on its own.
  it('rolls a bare clock time or day period to its next occurrence', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('a bare clock time must not need the model');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const evening = new Date(2026, 8, 24, 18, 0, 0).getTime();
      await expect(resolveSleepUntil('until morning', evening)).resolves.toBe(new Date(2026, 8, 25, 9, 0, 0).getTime());
      await expect(resolveSleepUntil('until 5pm', evening)).resolves.toBe(new Date(2026, 8, 25, 17, 0, 0).getTime());
      await expect(resolveSleepUntil('noon', evening)).resolves.toBe(new Date(2026, 8, 25, 12, 0, 0).getTime());
      await expect(resolveSleepUntil('midnight', evening)).resolves.toBe(new Date(2026, 8, 25, 0, 0, 0).getTime());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a bare clock time that is still ahead today', async () => {
    const morning = new Date(2026, 8, 24, 8, 0, 0).getTime();
    await expect(resolveSleepUntil('until 5pm', morning)).resolves.toBe(new Date(2026, 8, 24, 17, 0, 0).getTime());
    await expect(resolveSleepUntil('morning', morning)).resolves.toBe(new Date(2026, 8, 24, 9, 0, 0).getTime());
  });

  // A weekday named in the phrase must be resolved by the host. When this went
  // to the model it answered a Tuesday for "next friday at 10am", which the
  // weekday check then rejected — the phrase failed outright.
  it('resolves weekday phrases exactly as the host date does', async () => {
    const want = Number(String(execFileSync('date', ['-d', 'next friday 10am', '+%s'])).trim()) * 1000;
    await expect(resolveSleepUntil('next friday at 10am')).resolves.toBe(want);
  });
});
