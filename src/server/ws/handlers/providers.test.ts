import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetProviders = vi.fn();
const mockSaveProviders = vi.fn();
const mockTestProvider = vi.fn();
const mockIsConnected = vi.fn(() => true);

const mockClient = {
  nodeName: 'local',
  getProviders: mockGetProviders,
  saveProviders: mockSaveProviders,
  testProvider: mockTestProvider,
  isConnected: mockIsConnected,
};

vi.mock('../../init-state', () => ({
  getClientByNode: (name: string) => (name === 'local' ? mockClient : undefined),
}));

vi.mock('../../config/capabilities', () => ({
  nodesForClient: () => [{ name: 'local', connected: true, providers: {} }],
}));

const { handleProvidersGet, handleProvidersSave, handleProvidersTest } = await import('./providers');

function socket(role: 'admin' | 'user' = 'admin') {
  return { data: { identity: { id: 1, email: 'a@b.c', role } } } as never;
}
function acks() {
  const calls: Array<{ data?: unknown; error?: string }> = [];
  return { calls, cb: (res: { data?: unknown; error?: string }) => void calls.push(res) };
}
const io = { emit: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mockIsConnected.mockReturnValue(true);
});

describe('providers:get', () => {
  it('returns the node snapshot to an admin', async () => {
    mockGetProviders.mockResolvedValue({ configPath: '/x/orcd.yaml', providers: { a: {} }, defaultProvider: 'a', defaultModel: 'm' });
    const { calls, cb } = acks();

    await handleProvidersGet(socket(), { nodeName: 'local' }, cb);

    expect(calls[0]!.data).toEqual({
      nodeName: 'local',
      configPath: '/x/orcd.yaml',
      providers: { a: {} },
      defaultProvider: 'a',
      defaultModel: 'm',
    });
  });

  it('refuses a non-admin without touching the node', async () => {
    const { calls, cb } = acks();

    await handleProvidersGet(socket('user'), { nodeName: 'local' }, cb);

    expect(calls[0]!.error).toMatch(/admin/i);
    expect(mockGetProviders).not.toHaveBeenCalled();
  });

  it('names the node when it is unknown or offline', async () => {
    const unknown = acks();
    await handleProvidersGet(socket(), { nodeName: 'ghost' }, unknown.cb);
    expect(unknown.calls[0]!.error).toMatch(/Unknown node "ghost"/);

    mockIsConnected.mockReturnValue(false);
    const offline = acks();
    await handleProvidersGet(socket(), { nodeName: 'local' }, offline.cb);
    expect(offline.calls[0]!.error).toMatch(/not connected/);
  });
});

describe('providers:save', () => {
  const payload = { nodeName: 'local', providers: { a: { models: {} } }, defaultProvider: 'a', defaultModel: 'm' };

  it('relays the edit and pushes fresh capabilities to every client', async () => {
    mockSaveProviders.mockResolvedValue(undefined);
    const { calls, cb } = acks();

    await handleProvidersSave(socket(), io as never, payload, cb);

    expect(mockSaveProviders).toHaveBeenCalledWith({
      providers: payload.providers,
      defaultProvider: 'a',
      defaultModel: 'm',
    });
    expect(io.emit).toHaveBeenCalledWith('nodes:updated', [{ name: 'local', connected: true, providers: {} }]);
    expect(calls[0]!.error).toBeUndefined();
  });

  it('surfaces a node rejection and does not push', async () => {
    mockSaveProviders.mockRejectedValue(new Error('Provider "a" needs a modelID.'));
    const { calls, cb } = acks();

    await handleProvidersSave(socket(), io as never, payload, cb);

    expect(calls[0]!.error).toBe('Provider "a" needs a modelID.');
    expect(io.emit).not.toHaveBeenCalled();
  });
});

describe('providers:test', () => {
  it('returns the node probe result', async () => {
    mockTestProvider.mockResolvedValue({ ok: false, detail: 'Nothing answered at http://127.0.0.1:1' });
    const { calls, cb } = acks();

    await handleProvidersTest(socket(), { nodeName: 'local', baseUrl: 'http://127.0.0.1:1' }, cb);

    expect(calls[0]!.data).toEqual({ ok: false, detail: 'Nothing answered at http://127.0.0.1:1' });
  });
});
