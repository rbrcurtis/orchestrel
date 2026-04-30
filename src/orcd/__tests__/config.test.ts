import { describe, it, expect } from 'vitest';
import { buildModelAliasEnv, parseConfig, resolveEnvVars } from '../config';

describe('resolveEnvVars', () => {
  it('replaces ${VAR} with env value', () => {
    expect(resolveEnvVars('key=${MY_KEY}', { MY_KEY: 'secret' })).toBe('key=secret');
  });

  it('leaves unset vars as empty string', () => {
    expect(resolveEnvVars('${MISSING}', {})).toBe('');
  });

  it('handles multiple vars in one string', () => {
    expect(resolveEnvVars('${A}:${B}', { A: 'x', B: 'y' })).toBe('x:y');
  });

  it('returns plain strings unchanged', () => {
    expect(resolveEnvVars('no-vars-here', {})).toBe('no-vars-here');
  });
});

describe('parseConfig (orcd shape)', () => {
  it('parses minimal config and flattens models to modelID list', () => {
    const yaml = `
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
defaultCwd: ~/projects

providers:
  anthropic:
    label: Anthropic
    baseUrl: https://api.anthropic.com
    apiKey: test-key
    models:
      sonnet: { label: "Sonnet 4.6", modelID: claude-sonnet-4-6, contextWindow: 200000 }
`;
    const cfg = parseConfig(yaml, {});
    expect(cfg.defaultProvider).toBe('anthropic');
    expect(cfg.providers.anthropic.baseUrl).toBe('https://api.anthropic.com');
    expect(cfg.providers.anthropic.apiKey).toBe('test-key');
    expect(cfg.providers.anthropic.models).toEqual(['claude-sonnet-4-6']);
  });

  it('resolves env vars in apiKey', () => {
    const yaml = `
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
providers:
  anthropic:
    label: Anthropic
    baseUrl: https://api.anthropic.com
    apiKey: \${ANTHROPIC_API_KEY}
    models:
      sonnet: { label: "Sonnet 4.6", modelID: claude-sonnet-4-6, contextWindow: 200000 }
`;
    const cfg = parseConfig(yaml, { ANTHROPIC_API_KEY: 'sk-live-123' });
    expect(cfg.providers.anthropic.apiKey).toBe('sk-live-123');
  });

  it('omits apiKey/baseUrl when absent (Max OAuth path)', () => {
    const yaml = `
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
providers:
  anthropic:
    label: Anthropic
    models:
      sonnet: { label: "Sonnet 4.6", modelID: claude-sonnet-4-6, contextWindow: 200000 }
`;
    const cfg = parseConfig(yaml, {});
    expect(cfg.providers.anthropic.baseUrl).toBe('');
    expect(cfg.providers.anthropic.apiKey).toBe('');
  });

  it('throws on missing providers', () => {
    const yaml = `
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
`;
    expect(() => parseConfig(yaml, {})).toThrow();
  });
});

describe('buildModelAliasEnv', () => {
  const model = (modelID: string) => ({ label: modelID, modelID, contextWindow: 200000 });

  it('returns no aliases when the provider has no models', () => {
    expect(buildModelAliasEnv({})).toEqual({});
  });

  it('maps one model to opus, sonnet, and haiku', () => {
    expect(buildModelAliasEnv({ first: model('m1') })).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'm1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'm1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm1',
    });
  });

  it('maps two models with the second model also used for haiku', () => {
    expect(buildModelAliasEnv({ first: model('m1'), second: model('m2') })).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'm1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'm2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm2',
    });
  });

  it('maps only the first three models when more are configured', () => {
    expect(buildModelAliasEnv({
      first: model('m1'),
      second: model('m2'),
      third: model('m3'),
      fourth: model('m4'),
    })).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'm1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'm2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm3',
    });
  });
});
