import { describe, expect, it, vi } from 'vitest';
import { OrcdClient } from './orcd-client';

describe('OrcdClient dispatch ordering', () => {
  it('resolves create when orcd replies synchronously during send', async () => {
    const client = new OrcdClient({ host: '127.0.0.1', port: 0, token: 't', name: 'local' });
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
    const client = new OrcdClient({ host: '127.0.0.1', port: 0, token: 't', name: 'local' });
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
    const client = new OrcdClient({ host: '127.0.0.1', port: 0, token: 't', name: 'local' });
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
    const client = new OrcdClient({ host: '127.0.0.1', port: 0, token: 't', name: 'local' });
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

  it('constructs with host/port/token options', () => {
    const client = new OrcdClient({ host: '10.0.0.1', port: 7420, token: 'tok', name: 'gpubox' });
    expect(client.nodeName).toBe('gpubox');
  });

  it('correlates a request by requestId and resolves on reply', async () => {
    const client = new OrcdClient({ host: '127.0.0.1', port: 0, token: 't', name: 'local' });
    const internals = client as unknown as {
      socket: { writable: boolean };
      send: (a: { requestId?: string }) => void;
      dispatch: (m: unknown) => void;
    };
    internals.socket = { writable: true };
    internals.send = (a) => {
      internals.dispatch({ type: 'path_validated', requestId: a.requestId, exists: true, isGitRepo: true, defaultBranch: 'main' });
    };
    const res = await client.pathValidate('/repo');
    expect(res).toMatchObject({ exists: true, isGitRepo: true, defaultBranch: 'main' });
  });

  it('schedules a reconnect when the initial dial fails', async () => {
    const client = new OrcdClient({ host: '127.0.0.1', port: 1, token: 't', name: 'local' });
    await expect(client.connect()).rejects.toBeTruthy();
    const internals = client as unknown as { reconnectTimer: unknown };
    expect(internals.reconnectTimer).not.toBeNull();
    client.disconnect();
  });

  it('caches capabilities from a hello reply', async () => {
    const client = new OrcdClient({ host: '127.0.0.1', port: 0, token: 't', name: 'local' });
    const internals = client as unknown as {
      socket: { writable: boolean };
      send: (a: { requestId?: string }) => void;
      dispatch: (m: unknown) => void;
    };
    internals.socket = { writable: true };
    internals.send = (a) => {
      internals.dispatch({
        type: 'capabilities', requestId: a.requestId, name: 'local',
        providers: [{ id: 'anthropic', label: 'Anthropic', models: [{ alias: 'sonnet', label: 'Sonnet', contextWindow: 1000000 }] }],
        defaults: { provider: 'anthropic', model: 'sonnet' },
      });
    };
    const caps = await client.sayHello();
    expect(caps.providers[0].id).toBe('anthropic');
    expect(client.capabilities?.name).toBe('local');
  });
});
