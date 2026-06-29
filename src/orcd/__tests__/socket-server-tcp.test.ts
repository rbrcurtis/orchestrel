import { describe, it, afterEach } from 'vitest';
import { createConnection } from 'net';
import { OrcdServer } from '../socket-server';

function freePort() { return 7400 + Math.floor(Math.random() * 500); }

describe('OrcdServer TCP listener', () => {
  let server: OrcdServer | null = null;
  afterEach(() => { server?.stop(); server = null; });

  it('listens on host:port and accepts a TCP connection', async () => {
    const port = freePort();
    server = new OrcdServer(
      { listen: { host: '127.0.0.1', port }, authToken: 'tok', name: 'local' },
      { test: { type: 'anthropic', baseUrl: '', apiKey: '', models: ['m'], modelLabels: {}, modelAliasEnv: {} } },
      { provider: 'test', model: 'm' },
    );
    await server.start();
    await new Promise<void>((resolve, reject) => {
      const c = createConnection({ host: '127.0.0.1', port }, () => { c.end(); resolve(); });
      c.on('error', reject);
    });
  });
});
