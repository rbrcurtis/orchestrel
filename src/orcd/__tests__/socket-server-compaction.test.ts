import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { OrcdServer } from '../socket-server';
import { OrcdSession, type SessionEventCallback } from '../session';
import type { CompactAction, StreamEventMessage } from '../../shared/orcd-protocol';

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
  return new OrcdServer('/tmp/orcd-test.sock', {
    test: {
      type: 'anthropic',
      baseUrl: '',
      apiKey: '',
      models: { test: { label: 'Test Model', modelID: 'test-model', contextWindow: 100 } },
      modelAliasEnv: {},
    },
  }, { provider: 'test', model: 'test-model' });
}

describe('OrcdServer prompt passthrough', () => {
  it('passes slash prompts through unchanged on session create', async () => {
    expect(await collectPromptFromCreate('/ask hello')).toBe('/ask hello');
  });

  it('passes slash prompts through unchanged on follow-up messages', async () => {
    expect(await collectPromptFromMessage('/ask hello')).toBe('/ask hello');
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

describe('OrcdServer provider env', () => {
  it('merges process env and model alias env without injecting provider runtime env', () => {
    const saved = {
      ORC_TEST_PROVIDER_ENV: process.env.ORC_TEST_PROVIDER_ENV,
      ORC_PROVIDER_RUNTIME_URL: process.env.ORC_PROVIDER_RUNTIME_URL,
      ORC_PROVIDER_RUNTIME_KEY: process.env.ORC_PROVIDER_RUNTIME_KEY,
      ORC_PROVIDER_RUNTIME_TOKEN: process.env.ORC_PROVIDER_RUNTIME_TOKEN,
      ORC_PROVIDER_RUNTIME_REGION: process.env.ORC_PROVIDER_RUNTIME_REGION,
      ORC_PROVIDER_RUNTIME_PROFILE: process.env.ORC_PROVIDER_RUNTIME_PROFILE,
    };

    try {
      delete process.env.ORC_PROVIDER_RUNTIME_URL;
      delete process.env.ORC_PROVIDER_RUNTIME_KEY;
      delete process.env.ORC_PROVIDER_RUNTIME_TOKEN;
      delete process.env.ORC_PROVIDER_RUNTIME_REGION;
      delete process.env.ORC_PROVIDER_RUNTIME_PROFILE;
      process.env.ORC_TEST_PROVIDER_ENV = 'from-process';

      const server = new OrcdServer('/tmp/orcd-test.sock', {
        test: {
          type: 'bedrock',
          baseUrl: 'https://provider.test',
          apiKey: 'provider-api-key',
          authToken: 'provider-auth-token',
          region: 'us-east-1',
          profile: 'provider-profile',
          models: { test: { label: 'Test Model', modelID: 'test-model', contextWindow: 100 } },
          modelAliasEnv: {
            ORC_DEFAULT_MODEL: 'test-model',
          },
        },
      }, { provider: 'test', model: 'test-model' });

      const env = server['buildProviderEnv']('test');

      expect(env.ORC_TEST_PROVIDER_ENV).toBe('from-process');
      expect(env.ORC_DEFAULT_MODEL).toBe('test-model');
      expect(env.ORC_PROVIDER_RUNTIME_URL).toBeUndefined();
      expect(env.ORC_PROVIDER_RUNTIME_KEY).toBeUndefined();
      expect(env.ORC_PROVIDER_RUNTIME_TOKEN).toBeUndefined();
      expect(env.ORC_PROVIDER_RUNTIME_REGION).toBeUndefined();
      expect(env.ORC_PROVIDER_RUNTIME_PROFILE).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
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
    const applySpy = vi.spyOn(session, 'applyBgCompaction').mockReturnValue();
    vi.spyOn(session, 'isIdle').mockReturnValue(true);
    vi.spyOn(session, 'latestEntryIsCompaction').mockReturnValue(false);
    await server['maybeStartBgc'](session);
    expect(prepSpy).toHaveBeenCalledWith(0.5, expect.any(Object));
    expect(applySpy).toHaveBeenCalledWith(result);
  });

  it('skips apply when a compaction already landed (staleness guard)', async () => {
    const server = createServer();
    const session = bgcSession('bgc-stale');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue({ summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 9, details: undefined } as never);
    const applySpy = vi.spyOn(session, 'applyBgCompaction').mockReturnValue();
    vi.spyOn(session, 'isIdle').mockReturnValue(true);
    vi.spyOn(session, 'latestEntryIsCompaction').mockReturnValue(true);
    await server['maybeStartBgc'](session);
    expect(applySpy).not.toHaveBeenCalled();
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

  it('starts BGC from explicit compact action and emits bgc_started', async () => {
    const server = createServer();
    const client = createClient();
    const session = bgcSession('bgc-manual');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const cb: SessionEventCallback = (m) => client.socket.write(JSON.stringify(m));
    client.subscriptions.set(session.id, cb);
    session.subscribe(cb);
    vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue({ summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 1, details: undefined } as never);
    vi.spyOn(session, 'applyBgCompaction').mockReturnValue();
    vi.spyOn(session, 'isIdle').mockReturnValue(true);
    vi.spyOn(session, 'latestEntryIsCompaction').mockReturnValue(false);
    server['handleAction'](client as never, { action: 'compact', sessionId: session.id, cwd: '/tmp', provider: 'test', model: 'm' } as CompactAction);
    await new Promise((r) => setTimeout(r, 0));
    const wrote = client.socket.write.mock.calls.map((c) => String(c[0]));
    expect(wrote.some((w) => w.includes('bgc_started'))).toBe(true);
  });

  it('runs Pi-native full compaction for mode:full without synthetic bgc markers', async () => {
    const server = createServer();
    const client = createClient();
    const session = bgcSession('compact-full');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const cb: SessionEventCallback = (m) => client.socket.write(JSON.stringify(m));
    client.subscriptions.set(session.id, cb);
    session.subscribe(cb);
    const compactSpy = vi.spyOn(session, 'compact').mockResolvedValue(undefined);
    const bgcSpy = vi.spyOn(session, 'prepareBgCompaction');
    server['handleAction'](client as never, { action: 'compact', sessionId: session.id, cwd: '/tmp', provider: 'test', model: 'm', mode: 'full' } as CompactAction);
    await new Promise((r) => setTimeout(r, 0));
    expect(compactSpy).toHaveBeenCalled();
    expect(bgcSpy).not.toHaveBeenCalled(); // full compaction, not background
    // Pi ends the turn itself; orcd must not inject "Background compaction" markers.
    const wrote = client.socket.write.mock.calls.map((c) => String(c[0]));
    expect(wrote.some((w) => w.includes('bgc_started'))).toBe(false);
    expect(wrote.some((w) => w.includes('compact_boundary'))).toBe(false);
  });

  it('defers the splice to run-end when the session is busy, then applies', async () => {
    const server = createServer();
    const session = bgcSession('bgc-defer');
    server.store.add(session);
    server['attachLifecycleHooks'](session);
    const result = { summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 7, details: undefined };
    vi.spyOn(session, 'prepareBgCompaction').mockResolvedValue(result as never);
    const applySpy = vi.spyOn(session, 'applyBgCompaction').mockReturnValue();
    vi.spyOn(session, 'isIdle').mockReturnValue(false);
    vi.spyOn(session, 'latestEntryIsCompaction').mockReturnValue(false);
    await server['maybeStartBgc'](session);
    expect(applySpy).not.toHaveBeenCalled(); // deferred, not applied mid-run
    await session['runBeforeExitHooks'](); // simulate run-end
    expect(applySpy).toHaveBeenCalledWith(result);
  });
});
