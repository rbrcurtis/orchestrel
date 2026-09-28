import { describe, it, expect } from 'vitest';
import { parseConfig, resolveEnvVars } from '../config';

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
    expect(cfg.providers.anthropic.models).toEqual({
      sonnet: { label: 'Sonnet 4.6', modelID: 'claude-sonnet-4-6', contextWindow: 200000 },
    });
    expect(cfg.listen).toEqual({ host: '127.0.0.1', port: 7420 });
    expect(cfg.providers.anthropic.modelLabels?.['claude-sonnet-4-6']).toEqual({
      alias: 'sonnet',
      label: 'Sonnet 4.6',
      contextWindow: 200000,
    });
    expect(cfg.providers.anthropic.label).toBe('Anthropic');
  });

  it('carries per-model thinking and summarize defaults into modelLabels', () => {
    const yaml = `
listen: { host: 127.0.0.1, port: 7420 }
authToken: tok
defaultProvider: ray
defaultModel: coder

providers:
  ray:
    label: Ray
    baseUrl: http://127.0.0.1:11434
    models:
      coder: { label: Coder, modelID: coder, contextWindow: 240000, thinkingLevel: medium, summarizeThreshold: 0.7 }
      spark: { label: Spark, modelID: spark, contextWindow: 65536 }
`;
    const cfg = parseConfig(yaml, {});
    expect(cfg.providers.ray.models.coder).toEqual({
      label: 'Coder',
      modelID: 'coder',
      contextWindow: 240000,
      thinkingLevel: 'medium',
      summarizeThreshold: 0.7,
    });
    // Models without the fields omit them, so the UI leaves current values alone.
    expect(cfg.providers.ray.models.spark).toEqual({ label: 'Spark', modelID: 'spark', contextWindow: 65536 });
    expect(cfg.providers.ray.modelLabels?.coder).toEqual({
      alias: 'coder',
      label: 'Coder',
      contextWindow: 240000,
      thinkingLevel: 'medium',
      summarizeThreshold: 0.7,
    });
    expect(cfg.providers.ray.modelLabels?.spark).toEqual({ alias: 'spark', label: 'Spark', contextWindow: 65536 });
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
    expect(
      parseConfig(yaml.replace('authToken: tok', 'authToken: tok\nringBufferSize: 20000'), {}).ringBufferSize,
    ).toBe(20000);
  });
});
