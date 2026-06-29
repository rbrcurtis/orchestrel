import { describe, expect, it } from 'vitest';
import { OrcdServer } from '../socket-server';

describe('buildCapabilities', () => {
  it('maps providers/models to the capabilities payload', () => {
    const server = new OrcdServer(
      { listen: { host: '127.0.0.1', port: 0 }, authToken: 't', name: 'gpubox' },
      {
        anthropic: {
          type: 'anthropic', label: 'Anthropic', baseUrl: '', apiKey: '', modelAliasEnv: {},
          models: ['claude-sonnet-4-6'],
          modelLabels: { 'claude-sonnet-4-6': { alias: 'sonnet', label: 'Sonnet', contextWindow: 1000000 } },
        },
      },
      { provider: 'anthropic', model: 'sonnet' },
    );
    const caps = server['buildCapabilities']('h1');
    expect(caps).toMatchObject({
      type: 'capabilities', requestId: 'h1', name: 'gpubox',
      defaults: { provider: 'anthropic', model: 'sonnet' },
    });
    expect(caps.providers[0]).toMatchObject({ id: 'anthropic', label: 'Anthropic' });
    expect(caps.providers[0].models[0]).toMatchObject({ alias: 'sonnet', label: 'Sonnet', contextWindow: 1000000 });
  });
});
