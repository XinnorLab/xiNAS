import { startServer } from './api/server.js';

async function main(): Promise<void> {
  const configPath = process.env.XINAS_API_CONFIG;
  const handle = await startServer(configPath !== undefined ? { configPath } : {});
  const addr = handle.address;
  // eslint-disable-next-line no-console
  console.log(
    'xinas-api listening on',
    typeof addr === 'string' ? addr : `${addr.address}:${addr.port}`,
  );
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('xinas-api failed to start:', err);
  process.exit(1);
});
