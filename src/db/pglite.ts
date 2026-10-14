import { PGlite } from '@electric-sql/pglite';
import type { Db } from './client.js';
import { migrate, READER_ROLE } from './client.js';

type Runner = { query: (sql: string, p?: any[]) => Promise<{ rows: any[] }>; exec: (sql: string) => Promise<Array<{ rows: any[] }>> };

const mk = (r: Runner): Db['query'] => async (sql, params) =>
  params ? { rows: (await r.query(sql, params as any[])).rows as any }
         : { rows: ((await r.exec(sql)).at(-1)?.rows ?? []) as any };

export async function pgliteDb(): Promise<Db> {
  const pg = new PGlite();
  const nested = (t: Runner, readOnly: boolean): Db => {
    const tx: Db = {
      query: mk(t),
      transaction: (inner) => inner(tx),
      asUser: readOnly ? (_u, inner) => inner(tx) : async () => { throw new Error('asUser bu bağlamda desteklenmiyor'); },
      close: async () => {},
    };
    return tx;
  };
  const db: Db = {
    query: mk(pg),
    transaction: (fn) => pg.transaction((t) => fn(nested(t as unknown as Runner, false))),
    asUser: (userId, fn) => pg.transaction(async (t) => {
      await t.exec(`SET LOCAL ROLE ${READER_ROLE}`);
      await t.query(`SELECT set_config('app.user_id', $1, true)`, [String(userId)]);
      return fn(nested(t as unknown as Runner, true));
    }),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}
