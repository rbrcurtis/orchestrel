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
listen: { host: 127.0.0.1, port: 7420 }
authToken: tok
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
    expect(cfg.listen).toEqual({ host: '127.0.0.1', port: 7420 });
    expect(cfg.providers.anthropic.modelLabels['claude-sonnet-4-6']).toEqual({
      alias: 'sonnet', label: 'Sonnet 4.6', contextWindow: 200000,
    });
    expect(cfg.providers.anthropic.label).toBe('Anthropic');
  });

  it('resolves env vars in apiKey', () => {
    const yaml = `
listen: { host: 127.0.0.1, port: 7420 }
authToken: tok
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
listen: { host: 127.0.0.1, port: 7420 }
authToken: tok
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
listen: { host: 127.0.0.1, port: 7420 }
authToken: tok
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
`;
    expect(() => parseConfig(yaml, {})).toThrow();
  });

  it('parses ringBufferSize with a default of 5000', () => {
    const yaml = `
listen: { host: 127.0.0.1, port: 7420 }
authToken: tok
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
providers:
  anthropic:
    label: Anthropic
    models:
      sonnet: { label: "Sonnet", modelID: claude-sonnet-4-6, contextWindow: 200000 }
`;
    expect(parseConfig(yaml, {}).ringBufferSize).toBe(5000);
    expect(parseConfig(yaml.replace('authToken: tok', 'authToken: tok\nringBufferSize: 20000'), {}).ringBufferSize).toBe(20000);
  });
});

describe('buildModelAliasEnv', () => {
  const model = (modelID: string) => ({ label: modelID, modelID, contextWindow: 200000 });

  it('returns no aliases when the provider has no models', () => {
    expect(buildModelAliasEnv({})).toEqual({});
  });

  it('positional fallback: maps one model to all three aliases', () => {
    expect(buildModelAliasEnv({ first: model('m1') })).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'm1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'm1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm1',
    });
  });

  it('positional fallback: maps two models with the second also used for haiku', () => {
    expect(buildModelAliasEnv({ first: model('m1'), second: model('m2') })).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'm1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'm2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm2',
    });
  });

  it('positional fallback: maps only the first three models', () => {
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

  it('explicit aliases: resolves model keys to modelIDs', () => {
    const models = { big: model('big-id'), small: model('small-id') };
    expect(buildModelAliasEnv(models, { primary: 'big', subagent: 'big', lightweight: 'small' })).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'big-id',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'big-id',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small-id',
    });
  });

  it('explicit aliases: all same key avoids thrashing', () => {
    const models = { main: model('qwen3-coder'), alt: model('qwen3-small') };
    expect(buildModelAliasEnv(models, { primary: 'main', subagent: 'main', lightweight: 'main' })).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder',
    });
  });

  it('explicit aliases: unspecified aliases default to first model', () => {
    const models = { big: model('big-id'), small: model('small-id') };
    expect(buildModelAliasEnv(models, { subagent: 'small' })).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'big-id',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'small-id',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'big-id',
    });
  });

  it('explicit aliases: empty aliases object defaults all to first model', () => {
    const models = { alpha: model('alpha-id'), beta: model('beta-id') };
    expect(buildModelAliasEnv(models, {})).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'alpha-id',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'alpha-id',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'alpha-id',
    });
  });
});
