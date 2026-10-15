import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrcdServer } from '../socket-server';
import type { OrcdMessage } from '../../shared/orcd-protocol';

const CONFIG = `listen: { host: 127.0.0.1, port: 7420 }
authToken: tok
name: local
defaultProvider: old
defaultModel: oldmodel
providers:
  old:
    label: Old
    baseUrl: https://old.example
    apiKey: k
    models:
      oldmodel: { label: Old, modelID: old-model, contextWindow: 200000 }
`;

function makeServer() {
  return new OrcdServer(
    { listen: { host: '127.0.0.1', port: 0 }, authToken: 't', name: 'local' },
    {
      old: {
        type: 'anthropic',
        label: 'Old',
        baseUrl: 'https://old.example',
        apiKey: 'k',
        models: { oldmodel: { label: 'Old', modelID: 'old-model', contextWindow: 200000 } },
        modelLabels: { 'old-model': { alias: 'oldmodel', label: 'Old', contextWindow: 200000 } },
      },
    },
    { provider: 'old', model: 'oldmodel' },
  );
}

function fakeClient() {
  const sent: OrcdMessage[] = [];
  const client = {
    socket: { writable: true, write: (chunk: string) => void sent.push(JSON.parse(chunk) as OrcdMessage) },
    subscriptions: new Map(),
    authenticated: true,
  };
  return { client, sent };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orcd-save-'));
  file = join(dir, 'orcd.yaml');
  writeFileSync(file, CONFIG, { mode: 0o600 });
  process.env.ORC_CONFIG = file;
});

afterEach(() => {
  delete process.env.ORC_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

const NEW_PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test',
    models: { sonnet: { label: 'Sonnet', modelID: 'claude-sonnet-4-6', contextWindow: 1000000 } },
  },
};

describe('providers_save', () => {
  it('swaps the running providers and re-advertises capabilities', () => {
    const server = makeServer();
    const { client, sent } = fakeClient();

    server['handleProvidersSave'](client as never, {
      action: 'providers_save',
      requestId: 'r1',
      providers: NEW_PROVIDERS,
      defaultProvider: 'anthropic',
      defaultModel: 'sonnet',
    } as never);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'capabilities', requestId: 'r1' });
    const caps = sent[0] as Extract<OrcdMessage, { type: 'capabilities' }>;
    expect(caps.providers.map((p) => p.id)).toEqual(['anthropic']);
    expect(caps.defaults).toEqual({ provider: 'anthropic', model: 'sonnet' });
    expect(caps.providers[0]!.models[0]).toMatchObject({ alias: 'sonnet', contextWindow: 1000000 });

    // New sessions read the swapped map; the previous object is left alone so a
    // session already running keeps the provider config it started with.
    expect(server['providers'].anthropic?.models.sonnet?.modelID).toBe('claude-sonnet-4-6');
    expect(server['defaults'].provider).toBe('anthropic');
  });

  it('reports validation problems and leaves the file alone', () => {
    const server = makeServer();
    const { client, sent } = fakeClient();

    server['handleProvidersSave'](client as never, {
      action: 'providers_save',
      requestId: 'r2',
      providers: { broken: { models: { sonnet: { label: 'S' } } } },
      defaultProvider: 'broken',
      defaultModel: 'sonnet',
    } as never);

    expect(sent[0]).toMatchObject({ type: 'error', requestId: 'r2' });
    expect((sent[0] as Extract<OrcdMessage, { type: 'error' }>).error).toMatch(/needs a modelID/);
    expect(readFileSync(file, 'utf8')).toBe(CONFIG);
    expect(server['providers'].old).toBeDefined();
  });
});

describe('providers_get', () => {
  it('answers with the raw file contents and its path', () => {
    const server = makeServer();
    const { client, sent } = fakeClient();

    server['handleAction'](client as never, { action: 'providers_get', requestId: 'g1' } as never);

    expect(sent[0]).toMatchObject({ type: 'providers', requestId: 'g1', configPath: file });
    const msg = sent[0] as Extract<OrcdMessage, { type: 'providers' }>;
    expect(Object.keys(msg.providers)).toEqual(['old']);
    expect(msg.defaultProvider).toBe('old');
  });
});
