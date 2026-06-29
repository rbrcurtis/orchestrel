import { describe, it, expect } from 'vitest';
import type { OrcdAction, OrcdMessage } from './orcd-protocol';

describe('orcd-protocol requestId', () => {
  it('allows an optional requestId on actions', () => {
    const a: OrcdAction = { action: 'list', requestId: 'r1' };
    expect(a.requestId).toBe('r1');
  });

  it('allows requestId to be omitted', () => {
    const a: OrcdAction = { action: 'list' };
    expect(a.requestId).toBeUndefined();
  });

  it('allows requestId echo on messages', () => {
    const m: OrcdMessage = { type: 'session_list', sessions: [], requestId: 'r1' };
    expect(m.requestId).toBe('r1');
  });
});
