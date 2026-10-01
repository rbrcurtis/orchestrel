import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { OrcdServer } from '../socket-server';
import { OrcdSession, type SessionEventCallback } from '../session';
import type { CompactAction, ContextUsageMessage, StreamEventMessage } from '../../shared/orcd-protocol';

async function createSkillProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrel-skill-project-'));
  await mkdir(join(dir, '.claude', 'skills', 'ask'), { recursive: true });
  await writeFile(
    join(dir, '.claude', 'skills', 'ask', 'SKILL.md'),
    '---\nname: ask\n---\n\nAnswer this: $ARGUMENTS\n',
  );
  return dir;
}

function createClient() {
  return {
    socket: { writable: true, write: vi.fn() },
    subscriptions: new Map<string, SessionEventCallback>(),
    authenticated: true,
  };
}

async function collectPromptFromCreate(prompt: string): Promise<string> {
  const dir = await createSkillProject();
  const runSpy = vi.spyOn(OrcdSession.prototype, 'run').mockResolvedValue();
  try {
    const server = createServer();
    const client = createClient();
    server['handleAction'](client as never, {
      action: 'create',
      prompt,
      cwd: dir,
      provider: 'test',
      model: 'test-model',
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    const call = runSpy.mock.calls[0]?.[0];
    if (!call) throw new Error('expected run call');
    return call.prompt;
  } finally {
    runSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
}

async function collectPromptFromMessage(prompt: string): Promise<string> {
  const dir = await createSkillProject();
  const sendSpy = vi.spyOn(OrcdSession.prototype, 'sendMessage').mockResolvedValue();
  try {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: dir,
      model: 'test-model',
      provider: 'test',
      sessionId: 'session-message',
    });
    server.store.add(session);
    server['attachLifecycleHooks'](session);

    server['handleAction'](client as never, {
      action: 'message',
      sessionId: session.id,
      prompt,
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0];
    if (!call) throw new Error('expected sendMessage call');
    return call[0];
  } finally {
    sendSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
}

function createServer() {
  return new OrcdServer(
    { listen: { host: '127.0.0.1', port: 0 }, authToken: 'tok', name: 'local' },
    {
      test: {
        type: 'anthropic',
        baseUrl: '',
        apiKey: '',
        models: { test: { label: 'Test Model', modelID: 'test-model', contextWindow: 100 } },
        modelLabels: {},
      },
    },
    { provider: 'test', model: 'test-model' },
  );
}

describe('OrcdServer prompt passthrough', () => {
  it('passes slash prompts through unchanged on session create', async () => {
    expect(await collectPromptFromCreate('/ask hello')).toBe('/ask hello');
  });

  it('passes slash prompts through unchanged on follow-up messages', async () => {
    expect(await collectPromptFromMessage('/ask hello')).toBe('/ask hello');
  });
});

describe('OrcdServer session lifecycle', () => {
  it('routes a resumed create through the resident session', () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test',
      sessionId: 'resident-session',
    });
    server.store.add(session);
    const sendSpy = vi.spyOn(session, 'sendMessage').mockResolvedValue();

    server['handleAction'](client as never, {
      action: 'create',
      prompt: 'continue',
      cwd: '/tmp',
      provider: 'test',
      model: 'test-model',
      sessionId: session.id,
    });

    expect(server.store.get(session.id)).toBe(session);
    expect(sendSpy).toHaveBeenCalledWith('continue', undefined, undefined);
  });

  it('updates the summarize threshold on a resident session', () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test',
      sessionId: 'threshold-session',
    });
    server.store.add(session);

    server['handleAction'](client as never, {
      action: 'set_summarize_threshold',
      sessionId: session.id,
      summarizeThreshold: 0.7,
    });

    expect(session.summarizeThreshold).toBe(0.7);
  });

  it('switches the provider/model of a resident session via set_model', () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test',
      sessionId: 'model-switch-session',
    });
    server.store.add(session);

    server['handleAction'](client as never, {
      action: 'set_model',
      sessionId: session.id,
      provider: 'test',
      model: 'other-model',
    });

    expect(session.model).toBe('other-model');
    expect(session.provider).toBe('test');
  });

  it('self-heals a stale runtime when a resumed create carries a different model', async () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test',
      sessionId: 'resident-model-change',
    });
    server.store.add(session);
    const sendSpy = vi.spyOn(session, 'sendMessage').mockResolvedValue();

    server['handleAction'](client as never, {
      action: 'create',
      prompt: 'continue',
      cwd: '/tmp',
      provider: 'test',
      model: 'other-model',
      sessionId: session.id,
    });

    // The switch lands (fields update synchronously when no runtime exists),
    // then the prompt starts after it resolves.
    expect(session.model).toBe('other-model');
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledWith('continue', undefined, undefined));
  });

  it('removes and disposes a closed resident session', () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test',
      sessionId: 'closed-session',
    });
    server.store.add(session);
    const disposeSpy = vi.spyOn(session, 'dispose').mockResolvedValue();

    server['handleAction'](client as never, { action: 'close', sessionId: session.id });

    expect(server.store.get(session.id)).toBeUndefined();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('OrcdServer subscriptions', () => {
  it('does not replay the full buffer on duplicate live subscribes without a cursor', () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp/project',
      model: 'test-model',
      provider: 'test',
      sessionId: 'session-subscribe',
    });
    server.store.add(session);
    session['emitSyntheticSystemEvent']('compact_boundary');

    server['handleAction'](client as never, { action: 'subscribe', sessionId: session.id });
    const writesAfterFirst = client.socket.write.mock.calls.length;
    expect(writesAfterFirst).toBe(1);

    server['handleAction'](client as never, { action: 'subscribe', sessionId: session.id });
    expect(client.socket.write).toHaveBeenCalledTimes(writesAfterFirst);
  });

  it('replays only events after the requested cursor for duplicate subscribes', () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp/project',
      model: 'test-model',
      provider: 'test',
      sessionId: 'session-subscribe-cursor',
    });
    server.store.add(session);
    session['emitSyntheticSystemEvent']('compact_boundary');
    session['emitSyntheticSystemEvent']('bgc_started');

    server['handleAction'](client as never, { action: 'subscribe', sessionId: session.id });
    client.socket.write.mockClear();

    server['handleAction'](client as never, { action: 'subscribe', sessionId: session.id, afterEventIndex: 0 });

    expect(client.socket.write).toHaveBeenCalledTimes(1);
    const line = client.socket.write.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');
    const msg = JSON.parse(line as string) as StreamEventMessage;
    expect(msg.eventIndex).toBe(1);
    expect(msg.event).toEqual(expect.objectContaining({ subtype: 'bgc_started' }));
  });
});

describe('OrcdServer background compaction', () => {
  function bgcSession(id: string) {
    const session = new OrcdSession({ cwd: '/tmp', model: 'm', provider: 'test', sessionId: id });
    session.lastContextTokens = 130_000;
    session.lastContextWindow = 200_000;
    return session;
  }

  it('triggers parallel prepare at threshold and applies when idle', async () => {
    const server = createServer();
    const session = bgcSession('bgc-apply');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const result = { summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 9, details: undefined };
    const prepSpy = vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue(result as never);
    const applySpy = vi.spyOn(session, 'applyBgCompaction').mockReturnValue(true);
    vi.spyOn(session, 'isIdle').mockReturnValue(true);
    await server['maybeStartBgc'](session);
    expect(prepSpy).toHaveBeenCalledWith(0.3, expect.any(Object), expect.any(Function));
    expect(applySpy).toHaveBeenCalledWith(result);
  });

  it('re-derives the cut when the prepared one is stale', async () => {
    const server = createServer();
    const session = bgcSession('bgc-stale');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const stale = { summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 9, details: undefined };
    const fresh = { summary: 'S2', firstKeptEntryId: 'e2', tokensBefore: 9, details: undefined };
    const prepSpy = vi
      .spyOn(session, 'prepareBgCompaction')
      .mockResolvedValueOnce(stale as never)
      .mockResolvedValueOnce(fresh as never);
    const applySpy = vi
      .spyOn(session, 'applyBgCompaction')
      .mockReturnValueOnce(false) // a compaction landed after we prepared
      .mockReturnValueOnce(true);
    vi.spyOn(session, 'isIdle').mockReturnValue(true);

    await server['maybeStartBgc'](session);

    expect(prepSpy).toHaveBeenCalledTimes(2);
    expect(applySpy).toHaveBeenNthCalledWith(1, stale);
    expect(applySpy).toHaveBeenNthCalledWith(2, fresh);
  });

  it('does not start a second BGC while one is in flight', async () => {
    const server = createServer();
    const session = bgcSession('bgc-guard');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const prepSpy = vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue(null as never);
    await Promise.all([server['maybeStartBgc'](session), server['maybeStartBgc'](session)]);
    expect(prepSpy).toHaveBeenCalledTimes(1);
  });

  it('does not re-attempt BGC at an unchanged context size after a no-op', async () => {
    const server = createServer();
    const session = bgcSession('bgc-noop');
    session.summarizeThreshold = 0.7;
    session.lastContextTokens = 180_000;
    session.lastContextWindow = 200_000;
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const written: string[] = [];
    session.subscribe((m) => written.push(JSON.stringify(m)));
    const prepSpy = vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue(null as never);
    const hook = [...session['subscribers']][0] as SessionEventCallback;
    const usage: ContextUsageMessage = {
      type: 'context_usage',
      sessionId: session.id,
      contextTokens: 180_000,
      contextWindow: 200_000,
    };

    // context_usage fires per streaming delta; a no-op must not retry at the same size.
    hook(usage);
    await new Promise((r) => setTimeout(r, 0));
    hook(usage);
    await new Promise((r) => setTimeout(r, 0));
    expect(prepSpy).toHaveBeenCalledTimes(1);
    // A failed prepare must not announce a "Background compaction started" line.
    expect(written.some((w) => w.includes('bgc_started'))).toBe(false);

    // A larger context means the branch changed, so one retry is due.
    session.lastContextTokens = 185_000;
    hook({ ...usage, contextTokens: 185_000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(prepSpy).toHaveBeenCalledTimes(2);
  });

  it('starts BGC from explicit compact action and emits bgc_started', async () => {
    const server = createServer();
    const client = createClient();
    const session = bgcSession('bgc-manual');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const cb: SessionEventCallback = (m) => client.socket.write(JSON.stringify(m));
    client.subscriptions.set(session.id, cb);
    session.subscribe(cb);
    vi.spyOn(session, 'prepareBgCompaction').mockImplementation(async (_f, _s, onStart) => {
      onStart?.();
      return { summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 1, details: undefined } as never;
    });
    vi.spyOn(session, 'applyBgCompaction').mockReturnValue(true);
    vi.spyOn(session, 'isIdle').mockReturnValue(true);
    server['handleAction'](
      client as never,
      { action: 'compact', sessionId: session.id, cwd: '/tmp', provider: 'test', model: 'm' } as CompactAction,
    );
    await new Promise((r) => setTimeout(r, 0));
    const wrote = client.socket.write.mock.calls.map((c) => String(c[0]));
    expect(wrote.some((w) => w.includes('bgc_started'))).toBe(true);
  });

  it('emits bgc_failed when an announced BGC attempt produces no splice', async () => {
    const server = createServer();
    const session = bgcSession('bgc-fail');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const emitted: string[] = [];
    session.subscribe((m) => emitted.push(JSON.stringify(m)));
    vi.spyOn(session, 'prepareBgCompaction').mockImplementation(async (_f, _s, onStart) => {
      onStart?.();
      throw new Error('Summarization failed: generation hit the token cap');
    });

    await server['maybeStartBgc'](session);

    // The UI holds its "compacting" state from bgc_started until a terminal event.
    expect(emitted.some((e) => e.includes('bgc_started'))).toBe(true);
    expect(emitted.some((e) => e.includes('bgc_failed') && e.includes('hit the token cap'))).toBe(true);
  });

  it('defers the splice to run-end when the session is busy, then applies', async () => {
    const server = createServer();
    const session = bgcSession('bgc-defer');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const result = { summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 7, details: undefined };
    vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue(result as never);
    const applySpy = vi.spyOn(session, 'applyBgCompaction').mockReturnValue(true);
    vi.spyOn(session, 'isIdle').mockReturnValue(false);
    await server['maybeStartBgc'](session);
    expect(applySpy).not.toHaveBeenCalled(); // deferred, not applied mid-run
    await session['runBeforeExitHooks'](); // simulate run-end
    expect(applySpy).toHaveBeenCalledWith(result);
  });

  it('compacts before dispatching a prompt when a run ended over the threshold', async () => {
    const server = createServer();
    const client = createClient();
    const session = bgcSession('bgc-dispatch');
    session.summarizeThreshold = 0.7;
    session.lastContextTokens = 180_000;
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const prepSpy = vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue(null as never);
    const sendSpy = vi.spyOn(session, 'sendMessage').mockResolvedValue();

    server['handleAction'](client as never, { action: 'message', sessionId: session.id, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 0));

    // 180k of 200k is past the 70% threshold, so the summary has to land first.
    expect(prepSpy).toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledWith('go', undefined, undefined);
  });

  it('holds a follow-up prompt until an in-flight compaction settles', async () => {
    const server = createServer();
    const client = createClient();
    const session = bgcSession('bgc-hold');
    session.summarizeThreshold = 0;
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const result = { summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 7, details: undefined };
    let release!: (r: typeof result) => void;
    const inFlight = new Promise<typeof result>((res) => {
      release = res;
    });
    const prepSpy = vi
      .spyOn(session, 'prepareBgCompaction')
      .mockImplementation(async (_f, _s, onStart) => {
        onStart?.();
        return inFlight;
      });
    vi.spyOn(session, 'applyBgCompaction').mockReturnValue(true);
    vi.spyOn(session, 'isIdle').mockReturnValue(true);
    const sendSpy = vi.spyOn(session, 'sendMessage').mockResolvedValue();

    const bgc = server['maybeStartBgc'](session);
    await new Promise((r) => setTimeout(r, 0));
    expect(prepSpy).toHaveBeenCalledTimes(1);

    server['handleAction'](client as never, { action: 'message', sessionId: session.id, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 0));
    // The splice has not landed yet — the prompt must wait, not run pre-compact.
    expect(sendSpy).not.toHaveBeenCalled();

    release(result);
    await bgc;
    await new Promise((r) => setTimeout(r, 0));
    expect(sendSpy).toHaveBeenCalledWith('go', undefined, undefined);
  });

  it('holds a resumed prompt on a resident session until an in-flight compaction settles', async () => {
    const server = createServer();
    const client = createClient();
    const session = bgcSession('bgc-hold-create');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const result = { summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 7, details: undefined };
    let release!: (r: typeof result) => void;
    const inFlight = new Promise<typeof result>((res) => {
      release = res;
    });
    vi.spyOn(session, 'prepareBgCompaction').mockImplementation(async () => inFlight);
    vi.spyOn(session, 'applyBgCompaction').mockReturnValue(true);
    vi.spyOn(session, 'isIdle').mockReturnValue(true);
    const sendSpy = vi.spyOn(session, 'sendMessage').mockResolvedValue();

    const bgc = server['maybeStartBgc'](session);
    await new Promise((r) => setTimeout(r, 0));

    server['handleAction'](client as never, {
      action: 'create',
      prompt: 'go',
      cwd: '/tmp',
      provider: 'test',
      model: 'm',
      sessionId: session.id,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sendSpy).not.toHaveBeenCalled();

    release(result);
    await bgc;
    await new Promise((r) => setTimeout(r, 0));
    expect(sendSpy).toHaveBeenCalledWith('go', undefined, undefined);
  });

  it('keeps a rehydrated session resident while a held prompt waits on its compaction', async () => {
    const server = createServer();
    const client = createClient();
    const result = { summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 1, details: undefined };
    let release!: (r: typeof result) => void;
    const inFlight = new Promise<typeof result>((res) => {
      release = res;
    });
    const prepSpy = vi.spyOn(OrcdSession.prototype, 'prepareBgCompaction').mockImplementation(async () => inFlight);
    const spies: ReturnType<typeof vi.spyOn>[] = [prepSpy];
    try {
      server['handleAction'](client as never, {
        action: 'compact',
        sessionId: 'bgc-hydrate',
        cwd: '/tmp',
        provider: 'test',
        model: 'm',
      } as CompactAction);
      await new Promise((r) => setTimeout(r, 0));
      const session = server.store.get('bgc-hydrate');
      expect(session).toBeDefined();
      spies.push(vi.spyOn(session!, 'applyBgCompaction').mockReturnValue(true));
      spies.push(vi.spyOn(session!, 'isIdle').mockReturnValue(true));
      const sendSpy = vi.spyOn(session!, 'sendMessage').mockResolvedValue();
      spies.push(sendSpy);

      server['handleAction'](client as never, { action: 'message', sessionId: 'bgc-hydrate', prompt: 'go' });
      await new Promise((r) => setTimeout(r, 0));
      release(result);
      await new Promise((r) => setTimeout(r, 0));

      // The compaction settled and the held prompt dispatched — the entry must
      // still be in the store for the turn and everything after it.
      expect(server.store.has('bgc-hydrate')).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith('go', undefined, undefined);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
