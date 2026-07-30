import { describe, it, expect } from 'vitest';
import { parseNodeRegistry, parseTitleGenerationConfig } from './nodes';

describe('parseNodeRegistry', () => {
  it('parses servers with env-resolved tokens', () => {
    const yaml = `
servers:
  - name: local
    host: 127.0.0.1
    port: 7420
    authToken: \${LOCAL_TOKEN}
  - name: gpubox
    host: 10.8.0.3
    port: 7420
    authToken: gpu-tok
`;
    const nodes = parseNodeRegistry(yaml, { LOCAL_TOKEN: 'l-tok' });
    expect(nodes).toEqual([
      { name: 'local', host: '127.0.0.1', port: 7420, authToken: 'l-tok' },
      { name: 'gpubox', host: '10.8.0.3', port: 7420, authToken: 'gpu-tok' },
    ]);
  });

  it('throws when servers is missing', () => {
    expect(() => parseNodeRegistry('foo: bar', {})).toThrow();
  });
});

describe('parseTitleGenerationConfig', () => {
  it('reads the title endpoint and optional API key', () => {
    const config = parseTitleGenerationConfig(`
titleGeneration:
  url: http://localhost:11434/api/generate
  model: llama3.2:1b-instruct-q4_k_m
  apiKey: \${TITLE_API_KEY}
`, { TITLE_API_KEY: 'secret' });

    expect(config).toEqual({
      url: 'http://localhost:11434/api/generate',
      model: 'llama3.2:1b-instruct-q4_k_m',
      apiKey: 'secret',
    });
  });
});
