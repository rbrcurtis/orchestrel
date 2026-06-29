import { loadOrcdConfig } from './config';
import { OrcdServer } from './socket-server';

async function main() {
  console.log('[orcd] starting...');
  const config = await loadOrcdConfig();
  const server = new OrcdServer(
    { listen: config.listen, authToken: config.authToken, name: config.name },
    config.providers,
    { provider: config.defaultProvider, model: config.defaultModel },
    config.memoryUpsert,
  );
  await server.start();
  const shutdown = () => { console.log('[orcd] shutting down...'); server.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch((err) => { console.error('[orcd] fatal:', err); process.exit(1); });
