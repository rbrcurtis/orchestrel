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
