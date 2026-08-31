import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, resetConfigCache } from './config';

describe('parseConfig listen/auth', () => {
  const base = `
listen:
  host: 0.0.0.0
  port: 7420
authToken: secret-tok
name: gpubox
defaultProvider: anthropic
defaultModel: sonnet
defaultThinkingLevel: medium
providers:
  anthropic:
    label: Anthropic
    models:
      sonnet: { label: "Sonnet", modelID: claude-sonnet-4-6, contextWindow: 1000000 }
`;
  it('parses listen, authToken, name', () => {
    const cfg = parseConfig(base, {});
    expect(cfg.listen).toEqual({ host: '0.0.0.0', port: 7420 });
    expect(cfg.authToken).toBe('secret-tok');
    expect(cfg.name).toBe('gpubox');
  });
  it('resolves authToken env vars', () => {
    const cfg = parseConfig(base.replace('secret-tok', '${ORCD_TOKEN}'), { ORCD_TOKEN: 'xyz' });
    expect(cfg.authToken).toBe('xyz');
  });
  it('defaults name to local when absent', () => {
    const cfg = parseConfig(base.replace('name: gpubox\n', ''), {});
    expect(cfg.name).toBe('local');
  });
  it('parses defaultThinkingLevel when present and leaves it undefined when absent', () => {
    expect(parseConfig(base, {}).defaultThinkingLevel).toBe('medium');
    expect(parseConfig(base.replace('defaultThinkingLevel: medium\n', ''), {}).defaultThinkingLevel).toBeUndefined();
  });
});

const MINIMAL = `
providers:
  max:
    models:
      assistant: { modelID: qwen3.8-27b-oq8, contextWindow: 262144 }
memory:
  provider: max
  model: assistant
  projects:
    trackable:
      match: ["/home/ryan/Code/trackable", "/home/ryan/Code/transcription"]
      apiUrl: https://memory.trackable.io
      apiKey: "\${TRACKABLE_MEMORY_API_KEY}"
      project: trackable
`;

describe('memory config', () => {
  beforeEach(() => resetConfigCache());

  it('parses a memory section with defaults', () => {
    const cfg = parseConfig(MINIMAL, { TRACKABLE_MEMORY_API_KEY: 'k' });
    expect(cfg.memory).toMatchObject({
      mode: 'stage',
      provider: 'max',
      model: 'assistant',
      maxTurns: 30,
      excerptTokens: 24000,
      settleMs: 600000,
    });
    expect(cfg.memory?.projects.trackable).toEqual({
      match: ['/home/ryan/Code/trackable', '/home/ryan/Code/transcription'],
      apiUrl: 'https://memory.trackable.io',
      apiKey: 'k',
      project: 'trackable',
    });
  });

  it('honors mode: write and telegram config', () => {
    const cfg = parseConfig(
      MINIMAL.replace('memory:', 'memory:\n  mode: write\n  telegram:\n    botToken: "${TELEGRAM_BOT_TOKEN}"\n    chatId: "123"'),
      { TELEGRAM_BOT_TOKEN: 't' },
    );
    expect(cfg.memory?.mode).toBe('write');
    expect(cfg.memory?.telegram).toEqual({ botToken: 't', chatId: '123' });
  });

  it('is absent when the section is missing', () => {
    const cfg = parseConfig(`providers:\n  max:\n    models:\n      assistant: { modelID: qwen3.8-27b-oq8 }`, {});
    expect(cfg.memory).toBeUndefined();
  });

  it('throws when a project entry is incomplete', () => {
    const bad = `
providers:
  max:
    models:
      assistant: { modelID: qwen3.8-27b-oq8 }
memory:
  provider: max
  model: assistant
  projects:
    trackable: { match: ["/x"], apiUrl: "http://x", project: "trackable" }
`;
    expect(() => parseConfig(bad, {})).toThrow('apiKey');
  });
});
