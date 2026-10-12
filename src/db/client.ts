import pg from 'pg';
import { migrations } from './schema.js';

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** fn içindeki tüm sorgular tek işlemde çalışır; hata olursa geri alınır. */
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  const wrap = (c: pg.Pool | pg.PoolClient): Db['query'] =>
    async (sql, params) => ({ rows: (await c.query(sql, params as any[])).rows });
  return {
    query: wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Db = {
          query: wrap(client),
          transaction: (inner) => inner(tx),
          close: async () => {},
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function migrate(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
  const current = rows[0]?.v ?? 0;
  for (let i = current; i < migrations.length; i++) {
    await db.transaction(async (tx) => {
      await tx.query(migrations[i]!);
      await tx.query('INSERT INTO schema_migrations(version) VALUES ($1)', [i + 1]);
    });
  }
}
