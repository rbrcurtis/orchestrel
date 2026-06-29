import { describe, expect, it, afterEach } from 'vitest';
import { createConnection, type Socket } from 'net';
import { OrcdServer } from '../socket-server';

function freePort() { return 7000 + Math.floor(Math.random() * 500); }

async function connectAndSend(port: number, lines: object[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    const c: Socket = createConnection({ host: '127.0.0.1', port }, () => {
      for (const l of lines) c.write(JSON.stringify(l) + '\n');
    });
    c.on('data', (d) => { out.push(...d.toString().split('\n').filter(Boolean)); });
    c.on('close', () => resolve(out));
    c.on('error', reject);
    setTimeout(() => c.end(), 150);
  });
}

describe('OrcdServer auth', () => {
  let server: OrcdServer | null = null;
  afterEach(() => { server?.stop(); server = null; });

  async function boot() {
    const port = freePort();
    server = new OrcdServer(
      { listen: { host: '127.0.0.1', port }, authToken: 'right', name: 'local' },
      { test: { type: 'anthropic', baseUrl: '', apiKey: '', models: ['m'], modelLabels: {}, modelAliasEnv: {} } },
      { provider: 'test', model: 'm' },
    );
    await server.start();
    return port;
  }

  it('replies capabilities on a valid hello', async () => {
    const port = await boot();
    const out = await connectAndSend(port, [{ action: 'hello', token: 'right', requestId: 'h1' }]);
    const msgs = out.map((l) => JSON.parse(l));
    expect(msgs.some((m) => m.type === 'capabilities' && m.requestId === 'h1')).toBe(true);
  });

  it('rejects and closes on a bad token', async () => {
    const port = await boot();
    const out = await connectAndSend(port, [{ action: 'hello', token: 'wrong', requestId: 'h1' }]);
    const msgs = out.map((l) => JSON.parse(l));
    expect(msgs.some((m) => m.type === 'error')).toBe(true);
  });

  it('drops actions issued before hello', async () => {
    const port = await boot();
    const out = await connectAndSend(port, [{ action: 'list', requestId: 'l1' }]);
    const msgs = out.map((l) => JSON.parse(l));
    expect(msgs.some((m) => m.type === 'session_list')).toBe(false);
  });
});
