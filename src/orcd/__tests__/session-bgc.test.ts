import { describe, expect, it } from 'vitest';
import { OrcdSession } from '../session';
import type { OrcdMessage } from '../../shared/orcd-protocol';

function syntheticSubtypes(s: OrcdSession): string[] {
  const seen: string[] = [];
  s.subscribe((m: OrcdMessage) => {
    if (m.type === 'stream_event') {
      const e = m.event as { type?: string; subtype?: string };
      if (e.type === 'system' && e.subtype) seen.push(e.subtype);
    }
  });
  return seen;
}

describe('OrcdSession BGC event mapping', () => {
  it('maps Pi compaction_start/end to bgc_started/compact_boundary', () => {
    const s = new OrcdSession({ cwd: '/tmp', model: 'm', provider: 'test', sessionId: 'idmap' });
    const seen = syntheticSubtypes(s);
    s['emitMappedPiEvent']({ type: 'compaction_start', reason: 'threshold' });
    s['emitMappedPiEvent']({ type: 'compaction_end', reason: 'threshold', result: { summary: 'x' } });
    expect(seen).toEqual(['bgc_started', 'compact_boundary']);
  });

  it('maps a manual /compact to its own compact_started/compact_done lifecycle, not BGC', () => {
    const s = new OrcdSession({ cwd: '/tmp', model: 'm', provider: 'test', sessionId: 'manual' });
    const seen = syntheticSubtypes(s);
    s['emitMappedPiEvent']({ type: 'compaction_start', reason: 'manual' });
    s['emitMappedPiEvent']({ type: 'compaction_end', reason: 'manual', result: { summary: 'x' } });
    expect(seen).toEqual(['compact_started', 'compact_done']);
  });

  it('isIdle reflects the running flag', () => {
    const s = new OrcdSession({ cwd: '/tmp', model: 'm', provider: 'test', sessionId: 'idle' });
    expect(s.isIdle()).toBe(true);
  });

  it('context_usage window prefers node config over a stale BE-passed value', () => {
    // Card 1875 regression: a fable (1M) card persisted contextWindow=200000 from
    // when the model was 200k. orcd must divide by config's live 1M window, else
    // BGC fires at ~90% mid-turn. Config wins; the stale BE value is only a fallback.
    const s = new OrcdSession({
      cwd: '/tmp',
      model: 'fable',
      provider: 'anthropic',
      sessionId: 'window',
      contextWindow: 200000, // stale card value
      providerConfig: { type: 'anthropic', label: 'Anthropic', baseUrl: '', apiKey: '', models: { fable: { label: 'Fable 5', modelID: 'claude-fable-5', contextWindow: 1000000 } } },
    });
    let win = 0;
    s.subscribe((m) => { if (m.type === 'context_usage') win = m.contextWindow; });
    s['emitMappedPiEvent']({ type: 'turn_end', message: { role: 'assistant', usage: { totalTokens: 186825 } } });
    expect(win).toBe(1000000);
  });

  it('does not swallow non-compaction events', () => {
    const s = new OrcdSession({ cwd: '/tmp', model: 'm', provider: 'test', sessionId: 'passthru' });
    const events: unknown[] = [];
    s.subscribe((m) => { if (m.type === 'stream_event') events.push(m.event); });
    s['emitMappedPiEvent']({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi', contentIndex: 0 } });
    expect(events.length).toBeGreaterThan(0);
    const subtypes = events.filter((e): e is { subtype?: string } => typeof e === 'object' && e !== null).map((e) => e.subtype);
    expect(subtypes).not.toContain('bgc_started');
    expect(subtypes).not.toContain('compact_boundary');
  });
});
