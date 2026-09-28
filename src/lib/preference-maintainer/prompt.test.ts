import { describe, expect, it } from 'vitest';
import type { MemoryHit } from '../memory-maintainer/memory-api';
import { buildPreferencePrompt, canonicalTitle } from './prompt';

const HIT: MemoryHit = { id: 'mem-7', title: 'Preferences: ryan@example.com', text: 'old body', score: 1 };

describe('buildPreferencePrompt', () => {
  it('is the deterministic one-per-user canonical title', () => {
    expect(canonicalTitle('ryan@example.com')).toBe('Preferences: ryan@example.com');
  });

  it('targets the existing canonical memory by id: read then update, never store', () => {
    const p = buildPreferencePrompt({
      email: 'ryan@example.com',
      title: canonicalTitle('ryan@example.com'),
      today: '2026-09-25',
      stalenessDays: 30,
      existing: HIT,
    });
    expect(p).toContain('Preferences: ryan@example.com');
    expect(p).toContain('read_memory(mem-7)');
    expect(p).toContain('update_memory(mem-7');
    // A wrong branch would store a second canonical memory every run.
    expect(p).not.toContain('store_memory');
  });

  it('stores the canonical memory when none exists', () => {
    const p = buildPreferencePrompt({
      email: 'ryan@example.com',
      title: canonicalTitle('ryan@example.com'),
      today: '2026-09-25',
      stalenessDays: 30,
      existing: null,
    });
    expect(p).toContain('store_memory');
    expect(p).toContain('Preferences: ryan@example.com');
    expect(p).not.toContain('update_memory');
  });

  it('carries the run date and staleness window into the pruning rules', () => {
    const p = buildPreferencePrompt({
      email: 'r@x.com',
      title: canonicalTitle('r@x.com'),
      today: '2026-09-25',
      stalenessDays: 14,
      existing: null,
    });
    expect(p).toContain('2026-09-25');
    expect(p).toContain('14 days');
  });
});
