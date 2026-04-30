import { loadOrcdConfig } from './config';
import { OrcdServer } from './socket-server';
import { homedir } from 'os';

async function main() {
  console.log('[orcd] starting...');

  const config = await loadOrcdConfig();

  // Resolve ~ in socket path
  const socketPath = config.socket.replace(/^~/, homedir());

  const extraSettings = (config.extraSettings ?? []).map(
    (p) => p.replace(/^~/, homedir()),
  );

  const server = new OrcdServer(socketPath, config.providers, {
    provider: config.defaultProvider,
    model: config.defaultModel,
  }, config.memoryUpsert, config.claudeCodePath, extraSettings);

  await server.start();

  const shutdown = () => {
    console.log('[orcd] shutting down...');
    server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[orcd] fatal:', err);
  process.exit(1);
});
