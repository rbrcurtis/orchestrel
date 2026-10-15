import { describe, expect, it, vi } from 'vitest';
import { ProviderConfigStore } from './provider-config-store';

const CONFIG = {
  configPath: '/x/orcd.yaml',
  providers: {
    anthropic: { label: 'Anthropic', models: { sonnet: { modelID: 'claude-sonnet-4-6' } } },
  },
  defaultProvider: 'anthropic',
  defaultModel: 'sonnet',
};

function storeWith(emit: (event: string, data: unknown) => Promise<unknown>) {
  const store = new ProviderConfigStore();
  store.setWs({ emit } as never);
  return store;
}

describe('ProviderConfigStore', () => {
  it('loads a node snapshot and starts clean', async () => {
    const store = storeWith(vi.fn().mockResolvedValue(CONFIG));

    await store.load('local');

    expect(store.configPath).toBe('/x/orcd.yaml');
    expect(store.entries).toHaveLength(1);
    expect(store.modelCount).toBe(1);
    expect(store.dirty).toBe(false);
    expect(store.changeSummary).toBe('');
  });

  it('reports edits as dirty and clears them on save', async () => {
    const emit = vi.fn().mockResolvedValue(CONFIG);
    const store = storeWith(emit);
    await store.load('local');

    store.setProvider('openai', { label: 'OpenAI', models: { gpt5: { modelID: 'gpt-5' } } });
    expect(store.dirty).toBe(true);
    expect(store.changeSummary).toBe('+1 provider');

    emit.mockResolvedValue(undefined);
    expect(await store.save()).toBe(true);
    expect(store.dirty).toBe(false);
    expect(emit).toHaveBeenLastCalledWith('providers:save', {
      nodeName: 'local',
      providers: store.providers,
      defaultProvider: 'anthropic',
      defaultModel: 'sonnet',
    });
  });

  it('keeps the draft and surfaces the node message when a save is rejected', async () => {
    const emit = vi.fn().mockResolvedValue(CONFIG);
    const store = storeWith(emit);
    await store.load('local');
    store.setProvider('broken', { models: {} });

    emit.mockRejectedValue(new Error('Provider "broken" needs at least one model.'));
    expect(await store.save()).toBe(false);

    expect(store.error).toBe('Provider "broken" needs at least one model.');
    expect(store.dirty).toBe(true);
    expect(store.providers.broken).toBeDefined();
  });

  it('repoints the defaults when the default provider is removed', async () => {
    const store = storeWith(vi.fn().mockResolvedValue(CONFIG));
    await store.load('local');

    store.removeProvider('anthropic');

    expect(store.defaultProvider).toBe('');
    expect(store.defaultModel).toBe('');
  });

  it('repairs a default that no longer names one of the provider models', async () => {
    const store = storeWith(vi.fn().mockResolvedValue(CONFIG));
    await store.load('local');
    store.defaultModel = 'ghost';

    store.setDefaultProvider('anthropic');

    expect(store.defaultModel).toBe('sonnet');
  });

  it('discards back to the last loaded state', async () => {
    const store = storeWith(vi.fn().mockResolvedValue(CONFIG));
    await store.load('local');
    store.setProvider('openai', { models: { gpt5: { modelID: 'gpt-5' } } });
    store.setDefaultProvider('openai');

    store.discard();

    expect(store.dirty).toBe(false);
    expect(store.entries.map(([id]) => id)).toEqual(['anthropic']);
    expect(store.defaultProvider).toBe('anthropic');
  });
});
