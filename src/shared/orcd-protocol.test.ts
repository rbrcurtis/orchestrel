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

  it('models hello action and capabilities message', () => {
    const hello: OrcdAction = { action: 'hello', token: 'secret', requestId: 'h1' };
    expect(hello.action).toBe('hello');

    const caps: OrcdMessage = {
      type: 'capabilities',
      requestId: 'h1',
      name: 'gpubox',
      providers: [
        { id: 'anthropic', label: 'Anthropic', models: [{ alias: 'sonnet', label: 'Sonnet', contextWindow: 1000000 }] },
      ],
      defaults: { provider: 'anthropic', model: 'sonnet' },
    };
    expect(caps.type).toBe('capabilities');
  });
});
