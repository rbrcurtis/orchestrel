import { describe, it, expect } from 'vitest';
import { ConfigStore } from './config-store';

const FIXTURE = {
  anthropic: {
    label: 'Anthropic',
    models: {
      sonnet: { label: 'Sonnet 4.6', modelID: 'claude-sonnet-4-6', contextWindow: 200000 },
      opus: { label: 'Opus 4.6', modelID: 'claude-opus-4-6', contextWindow: 200000 },
    },
  },
  okkanti: {
    label: 'Kiro — Okkanti',
    models: {
      auto: { label: 'Auto', modelID: 'auto', contextWindow: 200000 },
      sonnet: { label: 'Sonnet 4.6', modelID: 'claude-sonnet-4-6', contextWindow: 200000 },
    },
  },
};

describe('ConfigStore', () => {
  describe('hydrate()', () => {
    it('stores providers data', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.providers).toEqual(FIXTURE);
    });

    it('replaces existing providers on re-hydrate', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      store.hydrate({ anthropic: FIXTURE.anthropic });
      expect(Object.keys(store.providers)).toEqual(['anthropic']);
    });
  });

  describe('getProvider()', () => {
    it('returns provider config by ID', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.getProvider('anthropic')).toEqual(FIXTURE.anthropic);
    });

    it('returns undefined for unknown provider', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.getProvider('unknown')).toBeUndefined();
    });
  });

  describe('getModels()', () => {
    it('returns model entries as [alias, config] pairs', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      const models = store.getModels('anthropic');
      expect(models).toEqual([
        ['sonnet', FIXTURE.anthropic.models.sonnet],
        ['opus', FIXTURE.anthropic.models.opus],
      ]);
    });

    it('returns empty array for unknown provider', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.getModels('unknown')).toEqual([]);
    });
  });

  describe('getModel()', () => {
    it('returns specific model config', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.getModel('anthropic', 'opus')).toEqual(FIXTURE.anthropic.models.opus);
    });

    it('returns undefined for unknown model alias', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.getModel('anthropic', 'haiku')).toBeUndefined();
    });

    it('returns undefined for unknown provider', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.getModel('unknown', 'sonnet')).toBeUndefined();
    });
  });

  describe('getDefaultModel()', () => {
    it('returns the first model key for a known provider', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.getDefaultModel('anthropic')).toBe('sonnet');
    });

    it('returns the first model key for okkanti (auto)', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.getDefaultModel('okkanti')).toBe('auto');
    });

    it('falls back to "sonnet" for unknown provider', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.getDefaultModel('unknown')).toBe('sonnet');
    });

    it('falls back to "sonnet" before hydration', () => {
      const store = new ConfigStore();
      expect(store.getDefaultModel('anthropic')).toBe('sonnet');
    });
  });

  describe('allProviders', () => {
    it('returns all provider entries as [id, config] pairs', () => {
      const store = new ConfigStore();
      store.hydrate(FIXTURE);
      expect(store.allProviders).toEqual([
        ['anthropic', FIXTURE.anthropic],
        ['okkanti', FIXTURE.okkanti],
      ]);
    });

    it('returns empty array before hydration', () => {
      const store = new ConfigStore();
      expect(store.allProviders).toEqual([]);
    });
  });
});
