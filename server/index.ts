import { mkdirSync } from 'node:fs';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const app = await buildApp(config, { logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}

await app.listen({ host: config.host, port: config.port });
