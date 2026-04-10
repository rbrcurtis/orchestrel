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

describe('parseConfig', () => {
  it('parses minimal config', () => {
    const yaml = `
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
defaultCwd: ~/projects
defaultEffort: high

providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: test-key
    models:
      - claude-sonnet-4-6
`;
    const cfg = parseConfig(yaml, {});
    expect(cfg.defaultProvider).toBe('anthropic');
    expect(cfg.providers.anthropic.baseUrl).toBe('https://api.anthropic.com');
    expect(cfg.providers.anthropic.models).toContain('claude-sonnet-4-6');
  });

  it('resolves env vars in apiKey', () => {
    const yaml = `
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: \${ANTHROPIC_API_KEY}
    models:
      - claude-sonnet-4-6
`;
    const cfg = parseConfig(yaml, { ANTHROPIC_API_KEY: 'sk-live-123' });
    expect(cfg.providers.anthropic.apiKey).toBe('sk-live-123');
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
