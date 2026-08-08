import { describe, expect, it } from 'vitest';
import { ConfigStore } from './config-store';
import { DEFAULT_SENTINEL } from '../../src/shared/ws-protocol';

const LOCAL = {
  trackable: {
    label: 'Trackable',
    models: {
      auto: { label: 'Auto', modelID: 'auto', contextWindow: 200000 },
      'gpt-5.6-sol': { label: 'GPT-5.6 Sol', modelID: 'gpt-5.6-sol', contextWindow: 272000 },
    },
  },
};

const ONI = {
  trackable: {
    label: 'Trackable',
    models: {
      auto: { label: 'Auto', modelID: 'auto', contextWindow: 200000 },
      opus: { label: 'Opus 4.6', modelID: 'claude-opus-4-6', contextWindow: 200000 },
    },
  },
};

describe('ConfigStore node capabilities', () => {
  it('keeps providers with the same ID isolated by node', () => {
    const store = new ConfigStore();
    store.hydrateNodes([
      { name: 'local', connected: true, providers: LOCAL, defaults: { provider: 'trackable', model: 'auto' } },
      { name: 'oni', connected: true, providers: ONI, defaults: { provider: 'trackable', model: 'auto' } },
    ]);

    expect(store.getModelsForNode('local', 'trackable').map(([alias]) => alias)).toEqual(['auto', 'gpt-5.6-sol']);
    expect(store.getModelsForNode('oni', 'trackable').map(([alias]) => alias)).toEqual(['auto', 'opus']);
    expect(store.getModelForNode('oni', 'trackable', 'gpt-5.6-sol')).toBeUndefined();
  });

  it('replaces node capabilities on re-hydration', () => {
    const store = new ConfigStore();
    store.hydrateNodes([{ name: 'local', connected: true, providers: LOCAL }]);
    store.hydrateNodes([{ name: 'oni', connected: false, providers: {} }]);

    expect(store.nodeByName('local')).toBeUndefined();
    expect(store.connectedNodes).toEqual([]);
    expect(store.providersForNode('oni')).toEqual({});
  });

  it('returns provider entries and defaults for one node only', () => {
    const store = new ConfigStore();
    store.hydrateNodes([{ name: 'local', connected: true, providers: LOCAL }]);

    expect(store.providersEntriesForNode('local').map(([id]) => id)).toEqual(['trackable']);
    expect(store.defaultModelForNode('local', 'trackable')).toBe('auto');
    expect(store.defaultModelForNode('unknown', 'trackable')).toBe('sonnet');
  });
});

describe('ConfigStore resolveDefaults', () => {
  const withDefaults = {
    name: 'local',
    connected: true,
    providers: LOCAL,
    defaults: { provider: 'trackable', model: 'auto', thinkingLevel: 'low' },
  };

  it('replaces the default sentinel with the node defaults', () => {
    const store = new ConfigStore();
    store.hydrateNodes([withDefaults]);
    expect(store.resolveDefaults('local', DEFAULT_SENTINEL, DEFAULT_SENTINEL, DEFAULT_SENTINEL)).toEqual({
      provider: 'trackable',
      model: 'auto',
      thinkingLevel: 'low',
    });
  });

  it('passes concrete provider, model, and thinking through unchanged', () => {
    const store = new ConfigStore();
    store.hydrateNodes([withDefaults]);
    expect(store.resolveDefaults('local', 'trackable', 'gpt-5.6-sol', 'adaptive')).toEqual({
      provider: 'trackable',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'adaptive',
    });
  });

  it('falls back when the node has no advertised defaults', () => {
    const store = new ConfigStore();
    store.hydrateNodes([{ name: 'local', connected: true, providers: LOCAL }]);
    expect(store.resolveDefaults('local', DEFAULT_SENTINEL, DEFAULT_SENTINEL, DEFAULT_SENTINEL)).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
      thinkingLevel: 'high',
    });
  });
});
