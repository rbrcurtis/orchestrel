import { describe, expect, it } from 'vitest';
import { estTokens, pruneToBudget } from './maintain';

describe('pruneToBudget', () => {
  const line = (s: string, seen: string) => `${'x'.repeat(80)} ${s} (seen: ${seen})`;

  it('returns the text unchanged when it fits the budget', () => {
    const text = [line('a', '2026-09-28'), line('b', '2026-09-29')].join('\n');
    expect(pruneToBudget(text, 2000)).toBe(text);
  });

  it('keeps the most recently seen lines first and preserves original order', () => {
    const old = line('oldest', '2026-08-01');
    const mid = line('middle', '2026-09-10');
    const recent = line('recent', '2026-09-29');
    // Budget fits exactly two of the three lines.
    const maxTokens = estTokens(recent) + estTokens(mid) + 1;
    const out = pruneToBudget([old, mid, recent].join('\n'), maxTokens);
    const outLines = out.split('\n');
    expect(outLines).toHaveLength(2);
    // Original order preserved: middle (idx 1) then recent (idx 2).
    expect(outLines[0]).toContain('middle');
    expect(outLines[1]).toContain('recent');
    expect(estTokens(out)).toBeLessThanOrEqual(maxTokens);
  });

  it('keeps the single most recent line when nothing fits', () => {
    const huge = 'y'.repeat(9999) + ' (seen: 2026-09-01)';
    const newer = 'z' + ' (seen: 2026-09-29)';
    const out = pruneToBudget(`${huge}\n${newer}`, 5);
    expect(out).toBe(newer);
  });

  it('returns empty for empty text', () => {
    expect(pruneToBudget('', 10)).toBe('');
  });
});
