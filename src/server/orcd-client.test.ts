import { describe, expect, it, vi } from 'vitest';
import { OrcdClient } from './orcd-client';

describe('OrcdClient dispatch ordering', () => {
  it('awaits async handlers before dispatching the next message', async () => {
    const client = new OrcdClient('/tmp/test.sock');
    const events: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    client.onMessage(async (msg) => {
      if (msg.type === 'result') {
        events.push('result:start');
        await gate;
        events.push('result:end');
        return;
      }
      if (msg.type === 'session_exit') {
        events.push('exit');
      }
    });

    const dispatch = client as unknown as {
      dispatch: (msg: unknown) => void;
      dispatchChain: Promise<void>;
    };

    dispatch.dispatch({
      type: 'result',
      sessionId: 'sess-1',
      eventIndex: 1,
      result: {},
    });
    dispatch.dispatch({
      type: 'session_exit',
      sessionId: 'sess-1',
      state: 'completed',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['result:start']);

    release();
    await dispatch.dispatchChain;
    expect(events).toEqual(['result:start', 'result:end', 'exit']);
  });

  it('continues dispatching after a handler throws', async () => {
    const client = new OrcdClient('/tmp/test.sock');
    const events: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    client.onMessage(async (msg) => {
      if (msg.type === 'result') {
        throw new Error('boom');
      }
      if (msg.type === 'session_exit') {
        events.push('exit');
      }
    });

    const dispatch = client as unknown as {
      dispatch: (msg: unknown) => void;
      dispatchChain: Promise<void>;
    };

    dispatch.dispatch({
      type: 'result',
      sessionId: 'sess-1',
      eventIndex: 1,
      result: {},
    });
    dispatch.dispatch({
      type: 'session_exit',
      sessionId: 'sess-1',
      state: 'completed',
    });

    await dispatch.dispatchChain;
    expect(events).toEqual(['exit']);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
