import { loadOrcdConfig } from './config';
import { startMaintainerScheduler, stopMaintainerScheduler } from './maintainer-scheduler';
import { OrcdServer } from './socket-server';

async function main() {
  console.log('[orcd] starting...');
  const config = await loadOrcdConfig();
  const server = new OrcdServer(
    {
      listen: config.listen,
      authToken: config.authToken,
      name: config.name,
      ringBufferSize: config.ringBufferSize,
      ...(config.defaultUser ? { defaultUser: config.defaultUser } : {}),
      ...(config.preferencesDir ? { preferencesDir: config.preferencesDir } : {}),
    },
    config.providers,
    {
      provider: config.defaultProvider,
      model: config.defaultModel,
      ...(config.defaultThinkingLevel ? { thinkingLevel: config.defaultThinkingLevel } : {}),
    },
  );
  await server.start();
  if (config.maintainers) {
    startMaintainerScheduler();
    console.log('[orcd] maintainer timers started (memory 02:00 daily + Sunday 03:00, preferences 00:00 daily)');
  }
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      console.log('[orcd] shutdown already in progress');
      return;
    }
    shuttingDown = true;
    console.log('[orcd] shutting down...');
    stopMaintainerScheduler();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
main().catch((err) => {
  console.error('[orcd] fatal:', err);
  process.exit(1);
});
