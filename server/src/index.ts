import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadOrCreateSecretKey, prepareConfigDir } from './config-dir.js';
import { openDatabase } from './db/index.js';
import { VERSION } from './version.js';

const WEB_ROOT = fileURLToPath(new URL('../../web/dist/web/browser', import.meta.url));

async function main() {
  const config = loadConfig();
  const paths = prepareConfigDir(config.configDir);
  loadOrCreateSecretKey(paths.secretKey);
  const db = openDatabase(paths.database);

  const app = await buildApp({ config, db, webRoot: WEB_ROOT });
  app.log.info(`Offbeat ${VERSION}, config dir ${paths.root}`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    db.$client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
