import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ConflictException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * PostgreSQL Erişim Katmanı.
 *
 * NEDEN ORM DEĞİL?
 *   Bu sistemin sıcak yolu (mesaj yazma/okuma) partition pruning, `RETURNING`
 *   ile atomik sayaç artırımı ve dikkatle yazılmış indeks kullanımına dayanır.
 *   ORM'ler bu sorguları üretmekte güvenilmezdir ve ürettikleri planı
 *   denetlemek, SQL yazmaktan daha zordur. Şema zaten elle tasarlandığı için
 *   ORM'in getirdiği soyutlama burada net bir kayıptır.
 *
 * KİRACI İZOLASYONU
 *   Şemada Row Level Security açıktır ve `app.current_org` oturum değişkenine
 *   bakar. Havuzlanmış (pooled) bağlantılarda `SET` KULLANILMAZ: bağlantı
 *   havuza döndüğünde değişken orada kalır ve bir sonraki isteğe SIZAR.
 *   Bu yüzden yalnızca `SET LOCAL` — transaction bitince otomatik düşer.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  /**
   * Havuz burada, `onModuleInit` yerine constructor'da kurulur.
   *
   * NEDEN? `CommonModule` `@Global()` olduğu için, DatabaseService'in
   * `onModuleInit`'inin diğer modüllerin (ör. DlpService) `onModuleInit`'inden
   * ÖNCE çalışacağı garanti değildir — Nest'in modül başlatma sırası global
   * modüller için belgelenmemiş bir iç detaydır. Gerçek bir çalıştırmada
   * `DlpService.onModuleInit` → `DatabaseService.query` → `this.pool`
   * `undefined` hatasıyla karşılaşıldı (bkz. günlük). `pg.Pool` yapıcısı
   * bağlantıyı hemen açmaz (tembel/lazy) — bu yüzden constructor'da
   * oluşturmak güvenlidir ve sıralama sorununu tamamen ortadan kaldırır.
   */
  constructor(private readonly config: ConfigService) {
    this.pool = new Pool({
      connectionString: this.config.getOrThrow<string>('DATABASE_URL'),
      // Havuz boyutu = (replika sayısı × max) < PostgreSQL max_connections.
      // Fazla bağlantı, PG'de her biri ayrı süreç olduğu için bellek tüketir
      // ve bağlam değiştirme (context switch) maliyetini artırır.
      max: this.config.get<number>('DB_POOL_MAX') ?? 20,
      idleTimeoutMillis: 30_000,
      // Bağlantı kurulamıyorsa hızlı başarısız ol — istek 30 sn asılı kalmasın.
      connectionTimeoutMillis: 5_000,
      // Tek bir sorgu havuzu sonsuza kadar tutamasın.
      statement_timeout: 15_000,
      query_timeout: 15_000,
      application_name: 'incompany-api',
      ssl: this.config.get('NODE_ENV') === 'production' ? { rejectUnauthorized: true } : undefined,
    });

    // Havuzdaki boşta bağlantı hatası yakalanmazsa süreç çöker.
    this.pool.on('error', (error) => {
      this.logger.error({ err: error.message }, 'Bosta havuz baglantisi hatasi');
    });

    this.logger.log('PostgreSQL havuzu hazir');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  // -------------------------------------------------------------------------
  //  Sorgu API'si
  // -------------------------------------------------------------------------

  /**
   * Tek sorgu. Kiracı kapsamı GEREKTİRMEYEN sorgular içindir
   * (sistem tabloları, kimlik doğrulama araması).
   */
  async query<T extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const start = process.hrtime.bigint();
    try {
      const result = await this.pool.query<T>(sql, params as unknown[]);
      this.trackSlowQuery(sql, start);
      return result.rows;
    } catch (error) {
      throw this.mapError(error, sql);
    }
  }

  /** Tam olarak bir satır bekler; yoksa 404, fazlaysa iç hata. */
  async queryOne<T extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
    notFoundMessage = 'Kayit bulunamadi',
  ): Promise<T> {
    const rows = await this.query<T>(sql, params);
    if (rows.length === 0) throw new NotFoundException(notFoundMessage);
    if (rows.length > 1) {
      // Tekil beklenen bir sorgunun çoklu satır dönmesi, sessizce ilkini
      // almak yerine hata vermelidir: bu bir veri bütünlüğü sorunudur.
      throw new InternalServerErrorException('Tekil sorgu birden fazla satir dondurdu');
    }
    return rows[0];
  }

  /** Sıfır veya bir satır. */
  async queryMaybe<T extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  //  Transaction
  // -------------------------------------------------------------------------

  /**
   * Transaction içinde çalıştırır. Hata durumunda otomatik ROLLBACK.
   *
   * `client.release()` `finally` bloğundadır: atlanırsa bağlantı havuza
   * dönmez ve yeterince tekrarında havuz tükenir — üretimde en sık görülen
   * "uygulama aniden yanıt vermiyor" sebeplerinden biridir.
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // ROLLBACK'in kendisi başarısızsa bağlantı bozuktur.
        this.logger.error(
          { err: (rollbackError as Error).message },
          'ROLLBACK basarisiz — baglanti bozuk',
        );
      }
      throw this.mapError(error, 'transaction');
    } finally {
      client.release();
    }
  }

  /**
   * Kiracı kapsamlı transaction — Row Level Security politikaları burada devreye girer.
   *
   * `SET LOCAL` transaction sonunda otomatik düşer; havuzlanmış bağlantıya
   * sızmaz. Uygulama kodundaki bir `WHERE org_id` unutulması artık veri
   * sızıntısına dönüşmez, çünkü PostgreSQL satırı zaten göstermez.
   */
  async withTenant<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      // set_config'in üçüncü parametresi `true` = LOCAL (transaction kapsamlı).
      // Parametreli çağrı, SET komutunun aksine SQL enjeksiyonuna kapalıdır.
      await client.query('SELECT set_config($1, $2, true)', ['app.current_org', orgId]);
      return fn(client);
    });
  }

  /** Sağlık kontrolü — readiness probe bunu kullanır. */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  get poolStats() {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  /**
   * PostgreSQL hata kodlarını HTTP semantiğine çevirir.
   * Ham `pg` hatası yayılırsa istemciye tablo ve kısıt adları sızar.
   */
  private mapError(error: unknown, context: string): Error {
    const pgError = error as { code?: string; constraint?: string; message?: string };

    switch (pgError.code) {
      case '23505': // unique_violation
        return new ConflictException('Bu kayit zaten mevcut');
      case '23503': // foreign_key_violation
        return new ConflictException('Iliskili kayit bulunamadi');
      case '23514': // check_violation
        return new ConflictException('Veri kisitlamalari saglanmadi');
      case '40001': // serialization_failure
      case '40P01': // deadlock_detected
        // Çağıran taraf yeniden deneyebilir — geçici bir durumdur.
        this.logger.warn({ code: pgError.code, context }, 'Serilestirme catismasi');
        return new ConflictException('Islem cakismasi, lutfen tekrar deneyin');
      case '57014': // query_canceled (statement_timeout)
        this.logger.error({ context }, 'Sorgu zaman asimi');
        return new InternalServerErrorException('Islem zaman asimina ugradi');
      default:
        this.logger.error(
          { code: pgError.code, constraint: pgError.constraint, err: pgError.message, context },
          'Veritabani hatasi',
        );
        return new InternalServerErrorException('Veritabani islemi basarisiz');
    }
  }

  /** Yavaş sorguları loglar — indeks eksikliğinin en erken sinyali. */
  private trackSlowQuery(sql: string, startNs: bigint): void {
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    if (durationMs > 200) {
      this.logger.warn(
        { durationMs: Math.round(durationMs), sql: sql.slice(0, 120).replace(/\s+/gu, ' ') },
        'Yavas sorgu',
      );
    }
  }
}
