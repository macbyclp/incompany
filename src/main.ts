import { resolve } from 'node:path';
import { pino } from 'pino';
import { buildServer } from './api/server.js';
import { ConnectorManager } from './connectors/manager.js';
import { migrate, pgDb } from './db/client.js';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} ortam değişkeni gerekli`);
  return v;
};

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const db = pgDb(need('DATABASE_URL'));
const appSecret = need('APP_SECRET');
if (appSecret.length < 24) throw new Error('APP_SECRET en az 24 karakter olmalı');

await migrate(db);
const manager = new ConnectorManager(db, appSecret, resolve(process.env.DATA_DIR ?? './data'), log);
const app = buildServer({ db, appSecret, connectors: {
  start: (id) => manager.start(id), stop: (id) => manager.stop(id),
  pairingQr: (id) => manager.pairingQr(id), sessionDir: (k, id) => manager.sessionDir(k, id),
}, logger: true });

await manager.startAll();
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) });

const shutdown = async () => { await app.close(); await manager.stopAll(); await db.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
