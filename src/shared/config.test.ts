import { describe, it, expect } from 'vitest';
import { parseConfig } from './config';

describe('parseConfig listen/auth', () => {
  const base = `
listen:
  host: 0.0.0.0
  port: 7420
authToken: secret-tok
name: gpubox
defaultProvider: anthropic
defaultModel: sonnet
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
});
