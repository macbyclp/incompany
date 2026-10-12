import { PGlite } from '@electric-sql/pglite';
import type { Db } from './client.js';
import { migrate } from './client.js';

export async function pgliteDb(): Promise<Db> {
  const pg = new PGlite();
  const mk = (run: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }>): Db['query'] =>
    async (sql, params) => ({ rows: (await run(sql, params)).rows as any });
  const db: Db = {
    query: mk(async (s, p) => p ? pg.query(s, p as any[]) : (await pg.exec(s)).at(-1) ?? { rows: [] }),
    async transaction(fn) {
      return pg.transaction(async (t) => {
        const tx: Db = { query: mk(async (s, p) => p ? t.query(s, p as any[]) : { rows: [] , ...(await t.exec(s)).at(-1) }), transaction: (inner) => inner(tx), close: async () => {} };
        return fn(tx);
      });
    },
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}
