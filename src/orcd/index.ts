import { loadOrcdConfig } from './config';
import { OrcdServer } from './socket-server';

async function main() {
  console.log('[orcd] starting...');
  const config = await loadOrcdConfig();
  const server = new OrcdServer(
    { listen: config.listen, authToken: config.authToken, name: config.name, ringBufferSize: config.ringBufferSize },
    config.providers,
    { provider: config.defaultProvider, model: config.defaultModel, ...(config.defaultThinkingLevel ? { thinkingLevel: config.defaultThinkingLevel } : {}) },
  );
  await server.start();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      console.log('[orcd] shutdown already in progress');
      return;
    }
    shuttingDown = true;
    console.log('[orcd] shutting down...');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
main().catch((err) => { console.error('[orcd] fatal:', err); process.exit(1); });
