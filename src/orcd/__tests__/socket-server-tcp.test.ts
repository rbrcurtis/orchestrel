import { describe, it, afterEach } from 'vitest';
import { createConnection, createServer } from 'net';
import { OrcdServer } from '../socket-server';

// Ask the kernel for a genuinely free port (a random draw can hit the live orcd).
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

describe('OrcdServer TCP listener', () => {
  let server: OrcdServer | null = null;
  afterEach(() => {
    server?.stop();
    server = null;
  });

  it('listens on host:port and accepts a TCP connection', async () => {
    const port = await freePort();
    server = new OrcdServer(
      { listen: { host: '127.0.0.1', port }, authToken: 'tok', name: 'local' },
      {
        test: {
          type: 'anthropic',
          baseUrl: '',
          apiKey: '',
          models: { m: { label: 'M', modelID: 'm', contextWindow: 1000 } },
          modelLabels: {},
        },
      },
      { provider: 'test', model: 'm' },
    );
    await server.start();
    await new Promise<void>((resolve, reject) => {
      const c = createConnection({ host: '127.0.0.1', port }, () => {
        c.end();
        resolve();
      });
      c.on('error', reject);
    });
  });
});
