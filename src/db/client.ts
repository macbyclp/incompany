import pg from 'pg';
import { migrations } from './schema.js';

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** fn içindeki tüm sorgular tek işlemde çalışır; hata olursa geri alınır. */
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
  /**
   * fn içindeki sorgular salt okunur bir işlemde, kısıtlı `incompany_reader` rolüyle çalışır
   * ve satır düzeyi güvenlik (RLS) bu kullanıcının kimliğine göre uygulanır. Sorgudaki
   * erişim filtresi bir hata yüzünden eksik kalsa bile veritabanı yetkisiz satırı vermez.
   */
  asUser<R>(userId: number, fn: (tx: Db) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export const READER_ROLE = 'incompany_reader';

export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  const wrap = (c: pg.Pool | pg.PoolClient): Db['query'] =>
    async (sql, params) => ({ rows: (await c.query(sql, params as any[])).rows });

  async function inTx<R>(begin: string, setup: (c: pg.PoolClient) => Promise<void>, build: (c: pg.PoolClient) => Db,
    fn: (tx: Db) => Promise<R>): Promise<R> {
    const client = await pool.connect();
    try {
      await client.query(begin);
      await setup(client);
      const result = await fn(build(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const unsupported = (what: string) => async (): Promise<never> => { throw new Error(`${what} bu bağlamda desteklenmiyor`); };
  const build = (client: pg.PoolClient, readOnly: boolean): Db => {
    const tx: Db = {
      query: wrap(client),
      transaction: (inner) => inner(tx),
      asUser: readOnly ? (_u, inner) => inner(tx) : unsupported('asUser'),
      close: async () => {},
    };
    return tx;
  };

  return {
    query: wrap(pool),
    transaction: (fn) => inTx('BEGIN', async () => {}, (c) => build(c, false), fn),
    asUser: (userId, fn) => inTx('BEGIN READ ONLY', async (c) => {
      await c.query(`SET LOCAL ROLE ${READER_ROLE}`);
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [String(userId)]);
    }, (c) => build(c, true), fn),
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
