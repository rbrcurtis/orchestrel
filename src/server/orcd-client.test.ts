import { describe, expect, it, vi } from 'vitest';
import { OrcdClient } from './orcd-client';

describe('OrcdClient dispatch ordering', () => {
  it('resolves create when orcd replies synchronously during send', async () => {
    const client = new OrcdClient('/tmp/test.sock');
    const internals = client as unknown as {
      socket: { writable: boolean };
      send: (action: unknown) => void;
      dispatch: (msg: unknown) => void;
    };
    internals.socket = { writable: true };
    internals.send = () => {
      internals.dispatch({ type: 'session_created', sessionId: 'sess-new' });
    };

    await expect(client.create({
      prompt: 'start',
      cwd: '/tmp/project',
      provider: 'anthropic',
      model: 'sonnet',
    })).resolves.toBe('sess-new');
  });

  it('rejects create when orcd returns a create-level error', async () => {
    const client = new OrcdClient('/tmp/test.sock');
    const internals = client as unknown as {
      socket: { writable: boolean };
      send: (action: unknown) => void;
      dispatch: (msg: unknown) => void;
    };
    internals.socket = { writable: true };
    internals.send = () => {
      internals.dispatch({ type: 'error', sessionId: '', error: 'unknown provider: missing' });
    };

    await expect(client.create({
      prompt: 'start',
      cwd: '/tmp/project',
      provider: 'missing',
      model: 'sonnet',
    })).rejects.toThrow('unknown provider: missing');
  });

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
