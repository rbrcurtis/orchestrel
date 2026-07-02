import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../config';
import { buildPiProviderRuntimeConfig } from '../pi-provider';

function providerConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test-key',
    authToken: 'auth-token-1',
    models: {
      sonnet: { label: 'Sonnet 4.6', modelID: 'claude-sonnet-4-6', contextWindow: 200000 },
    },
    modelAliasEnv: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
    },
    ...overrides,
  };
}

describe('buildPiProviderRuntimeConfig', () => {
  it('maps provider runtime fields', () => {
    const cfg = providerConfig();

    expect(buildPiProviderRuntimeConfig('anthropic', cfg, 'claude-sonnet-4-6')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test-key',
      authToken: 'auth-token-1',
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      },
    });
  });

  it('leaves baseUrl and apiKey undefined when configured as empty strings', () => {
    const cfg = providerConfig({ baseUrl: '', apiKey: '' });

    const out = buildPiProviderRuntimeConfig('anthropic', cfg, 'claude-sonnet-4-6');

    expect(out.baseUrl).toBeUndefined();
    expect(out.apiKey).toBeUndefined();
    expect(out.authToken).toBe('auth-token-1');
  });

  it('maps bedrock provider region and profile when present', () => {
    const cfg = providerConfig({
      type: 'bedrock',
      baseUrl: '',
      apiKey: '',
      authToken: undefined,
      region: 'us-west-2',
      profile: 'orchestrel-bedrock',
    });

    expect(buildPiProviderRuntimeConfig('bedrock', cfg, 'anthropic.claude-sonnet-4-6')).toEqual({
      providerId: 'bedrock',
      modelId: 'anthropic.claude-sonnet-4-6',
      type: 'bedrock',
      region: 'us-west-2',
      profile: 'orchestrel-bedrock',
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      },
    });
  });

  it('copies modelAliasEnv and does not mutate provider config env', () => {
    const cfg = providerConfig();

    const out = buildPiProviderRuntimeConfig('anthropic', cfg, 'claude-sonnet-4-6');

    expect(out.env).toEqual(cfg.modelAliasEnv);
    expect(out.env).not.toBe(cfg.modelAliasEnv);

    out.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-3-5';
    expect(cfg.modelAliasEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });
});
