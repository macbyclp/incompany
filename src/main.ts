import { resolve } from 'node:path';
import { pino } from 'pino';
import { buildServer } from './api/server.js';
import { ConnectorManager } from './connectors/manager.js';
import { loadKeyring } from './config.js';
import { purgeExpired } from './core/retention.js';
import { migrate, pgDb } from './db/client.js';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} ortam değişkeni gerekli`);
  return v;
};

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const db = pgDb(need('DATABASE_URL'));
const keyring = loadKeyring(process.env);

await migrate(db);
const manager = new ConnectorManager(db, keyring, resolve(process.env.DATA_DIR ?? './data'), log);
const app = buildServer({ db, appSecret: keyring, trustProxy: process.env.TRUST_PROXY === '1', connectors: {
  start: (id) => manager.start(id), stop: (id) => manager.stop(id),
  pairingQr: (id) => manager.pairingQr(id), sessionDir: (k, id) => manager.sessionDir(k, id),
}, logger: true });

await manager.startAll();
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) });

// Saklama süresi dolan mesajlar açılışta ve her 6 saatte bir silinir.
const purge = () => purgeExpired(db)
  .then((n) => { if (n) log.info({ deleted: n }, 'süresi dolan mesajlar silindi'); })
  .catch((err) => log.error({ err }, 'saklama süresi temizliği başarısız'));
void purge();
const purgeTimer = setInterval(purge, 6 * 3_600_000);
purgeTimer.unref();

const shutdown = async () => { await app.close(); await manager.stopAll(); await db.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
