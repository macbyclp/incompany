import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { DatabaseService } from '../common/database/database.service';

/**
 * Denetim İzi (Audit Trail).
 *
 * TASARIM GERİLİMİ: DAYANIKLILIK ↔ GECİKME
 *   Her denetim kaydını senkron yazmak, mesaj gönderimine bir veritabanı
 *   gidiş-dönüşü ekler. Tamamen asenkron yazmak ise süreç çöktüğünde
 *   kayıt kaybına yol açar — bu, uyum açısından kabul edilemez.
 *
 *   Çözüm: İKİ SINIF.
 *     · KRİTİK olaylar (rol atama, veri dışa aktarma, güvenlik) → SENKRON
 *     · Yüksek hacimli olaylar (mesaj okuma, dosya görüntüleme) → TOPLU (batch)
 *
 *   Toplu kuyruk `SIGTERM` sırasında boşaltılır; düzgün kapanmada kayıp olmaz.
 *   Ani çökmede en fazla 2 saniyelik düşük önemli kayıt kaybedilir.
 *
 * KURCALAMA DİRENCİ
 *   Hash zinciri ve UPDATE/DELETE engeli VERİTABANI seviyesindedir
 *   (bkz. 001_schema.sql). Uygulama kodundaki bir hata veya ele geçirilmiş
 *   bir uygulama hesabı denetim izini bozamaz.
 */

export interface AuditEntry {
  orgId: string;
  actorId?: string | null;
  actorEmail?: string | null;
  impersonatedBy?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  ipAddress?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  traceId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Senkron yazılması gereken olaylar.
 *
 * Ortak özellikleri: nadir, yüksek etkili ve bir ihlal soruşturmasında
 * "bu gerçekten oldu mu?" sorusunun yanıtı olacak olaylar.
 */
const CRITICAL_ACTIONS = new Set([
  'auth.login',
  'auth.login_failed',
  'auth.logout_all',
  'auth.token_reuse_detected',
  'role.assign',
  'role.revoke',
  'user.suspend',
  'user.deprovision',
  'channel.e2ee_enabled',
  'export.data',
  'audit.read',
  'dlp.blocked',
  'retention.purge',
  'key.rotate',
  'authz.denied',
]);

const BATCH_FLUSH_INTERVAL_MS = 2_000;
const BATCH_MAX_SIZE = 200;
/** Kuyruk bu boyutu aşarsa en eski kayıtlar düşürülür (bellek koruması). */
const QUEUE_HARD_LIMIT = 10_000;

@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private queue: AuditEntry[] = [];
  private flushTimer?: NodeJS.Timeout;
  private isFlushing = false;

  constructor(private readonly db: DatabaseService) {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, BATCH_FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  /**
   * Kapanış sırasında kuyruğu boşaltır.
   * `enableShutdownHooks()` sayesinde Nest bu metodu SIGTERM'de çağırır —
   * düzgün bir dağıtımda hiçbir denetim kaydı kaybolmaz.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }

  // -------------------------------------------------------------------------
  //  Genel API
  // -------------------------------------------------------------------------

  /**
   * Denetim kaydı oluşturur. Kritik olaylar senkron, diğerleri toplu yazılır.
   *
   * Bu metot ASLA istisna atmaz. Denetim yazımının başarısızlığı, asıl
   * işlemin (mesaj gönderme, giriş yapma) başarısız olmasına yol açmamalıdır.
   * Başarısızlığın kendisi loglanır ve alarm üretir.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      if (CRITICAL_ACTIONS.has(entry.action)) {
        await this.writeOne(entry);
        return;
      }

      if (this.queue.length >= QUEUE_HARD_LIMIT) {
        // Kuyruk taşıyorsa veritabanı çok yavaş veya erişilemez demektir.
        // Belleği tüketip süreci düşürmektense en eskiyi düşür ve alarm ver.
        this.queue.shift();
        this.logger.error('Denetim kuyrugu doldu — kayit dusuruldu');
      }

      this.queue.push(entry);
      if (this.queue.length >= BATCH_MAX_SIZE) void this.flush();
    } catch (error) {
      this.logger.error(
        { err: (error as Error).message, action: entry.action },
        'Denetim kaydi olusturulamadi',
      );
    }
  }

  /** Denetim kayıtlarını sorgular — `audit.read` izni gerektirir. */
  async search(filters: {
    orgId: string;
    actorId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    outcome?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: unknown[]; total: number }> {
    const conditions: string[] = ['org_id = $1'];
    const params: unknown[] = [filters.orgId];

    const push = (sql: string, value: unknown): void => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };

    if (filters.actorId) push('actor_id = ?', filters.actorId);
    if (filters.action) push('action = ?', filters.action);
    if (filters.resourceType) push('resource_type = ?', filters.resourceType);
    if (filters.resourceId) push('resource_id = ?', filters.resourceId);
    if (filters.outcome) push('outcome = ?::audit_outcome', filters.outcome);
    // Zaman aralığı, bölümlenmiş tabloda partition pruning'i tetikler —
    // aralık verilmezse tüm partition'lar taranır.
    if (filters.from) push('created_at >= ?', filters.from);
    if (filters.to) push('created_at <= ?', filters.to);

    const where = conditions.join(' AND ');
    const limit = Math.min(filters.limit ?? 50, 500);

    const [entries, countResult] = await Promise.all([
      this.db.query(
        `SELECT id, actor_id, actor_email, impersonated_by, action, resource_type,
                resource_id, outcome, ip_address, user_agent, metadata, created_at
           FROM audit_logs
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${Math.max(filters.offset ?? 0, 0)}`,
        params,
      ),
      this.db.queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_logs WHERE ${where}`,
        params,
      ),
    ]);

    return { entries, total: Number(countResult.count) };
  }

  /**
   * Hash zincirini doğrular.
   *
   * Günlük planlı görev olarak çalışır. Zincirdeki bir kırılma, denetim
   * kayıtlarının değiştirildiği anlamına gelir — bu, olabilecek en yüksek
   * öncelikli güvenlik alarmıdır ve derhal insan müdahalesi gerektirir.
   */
  async verifyChain(orgId: string, from: Date, to: Date): Promise<{
    valid: boolean;
    checked: number;
    brokenAt: string | null;
  }> {
    // RLS (`tenant_isolation_audit`) `app.current_org` ayarlanmadan bu
    // SELECT'i sessizce sıfır satıra düşürür — "zincir doğrulandı, kırık
    // yok" YANLIŞ pozitifi üretir ki bu, tam da bu fonksiyonun tespit
    // etmesi gereken türden bir kurcalamayı gizlemiş olurdu.
    const rows = await this.db.withTenant(orgId, (client) =>
      client
        .query<{ id: string; prev_hash: Buffer | null; record_hash: Buffer; created_at: Date }>(
          `SELECT id, prev_hash, record_hash, created_at
             FROM audit_logs
            WHERE org_id = $1 AND created_at BETWEEN $2 AND $3
            ORDER BY created_at ASC, id ASC`,
          [orgId, from, to],
        )
        .then((r) => r.rows),
    );

    for (let i = 1; i < rows.length; i += 1) {
      const expected = rows[i - 1].record_hash;
      const actual = rows[i].prev_hash;

      if (!actual || !expected.equals(actual)) {
        this.logger.error(
          { orgId, brokenAt: rows[i].id, at: rows[i].created_at },
          'DENETIM ZINCIRI KIRIK — olasi kurcalama',
        );
        return { valid: false, checked: rows.length, brokenAt: rows[i].id };
      }
    }

    return { valid: true, checked: rows.length, brokenAt: null };
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  private async writeOne(entry: AuditEntry): Promise<void> {
    // `audit_logs` üzerindeki `tenant_isolation_audit` politikası yalnızca
    // `USING` tanımlar; PostgreSQL, ayrı bir `WITH CHECK` yoksa aynı ifadeyi
    // INSERT'e de uygular. Yani `app.current_org` ayarlanmadan hiçbir satır
    // eklenemez — `withTenant` bunu transaction'a LOCAL olarak uygular.
    await this.db.withTenant(entry.orgId, async (client) => {
      await client.query(
        `INSERT INTO audit_logs (
           org_id, actor_id, actor_email, impersonated_by, action, resource_type,
           resource_id, outcome, ip_address, user_agent, session_id, trace_id, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::audit_outcome,$9,$10,$11,$12,$13::jsonb)`,
        [
          entry.orgId,
          entry.actorId ?? null,
          entry.actorEmail ?? null,
          entry.impersonatedBy ?? null,
          entry.action,
          entry.resourceType,
          entry.resourceId ?? null,
          entry.outcome ?? 'SUCCESS',
          entry.ipAddress ?? null,
          entry.userAgent ?? null,
          entry.sessionId ?? null,
          entry.traceId ?? null,
          JSON.stringify(this.redactMetadata(entry.metadata ?? {})),
        ],
      );
    });
  }

  /**
   * Toplu yazım.
   *
   * DİKKAT: hash zinciri tetikleyicisi SATIR BAZLIDIR ve önceki kaydın
   * hash'ini okur. Bu, toplu eklemenin de SIRALI çalışmasını gerektirir —
   * bu yüzden tek bir transaction içinde ardışık INSERT'ler kullanılır,
   * çok satırlı tek bir VALUES listesi değil. Çok satırlı ekleme, PostgreSQL'de
   * tetikleyicinin görmediği satırlara zincir kurmasına yol açardı.
   */
  private async flush(): Promise<void> {
    if (this.isFlushing || this.queue.length === 0) return;

    this.isFlushing = true;
    const batch = this.queue.splice(0, BATCH_MAX_SIZE);

    try {
      await this.db.transaction(async (client) => {
        for (const entry of batch) {
          // Parti farklı organizasyonlara ait kayıtlar içerebilir; RLS
          // politikası (`tenant_isolation_audit`) her satır için
          // `app.current_org`'un o satırın org_id'siyle eşleşmesini
          // gerektirir (bkz. writeOne yorumu) — bu yüzden her INSERT'ten
          // önce ayarlanır, döngü başında bir kez değil.
          await client.query('SELECT set_config($1, $2, true)', ['app.current_org', entry.orgId]);
          await client.query(
            `INSERT INTO audit_logs (
               org_id, actor_id, actor_email, action, resource_type,
               resource_id, outcome, ip_address, user_agent, session_id, trace_id, metadata
             ) VALUES ($1,$2,$3,$4,$5,$6,$7::audit_outcome,$8,$9,$10,$11,$12::jsonb)`,
            [
              entry.orgId,
              entry.actorId ?? null,
              entry.actorEmail ?? null,
              entry.action,
              entry.resourceType,
              entry.resourceId ?? null,
              entry.outcome ?? 'SUCCESS',
              entry.ipAddress ?? null,
              entry.userAgent ?? null,
              entry.sessionId ?? null,
              entry.traceId ?? null,
              JSON.stringify(this.redactMetadata(entry.metadata ?? {})),
            ],
          );
        }
      });
    } catch (error) {
      this.logger.error(
        { err: (error as Error).message, count: batch.length },
        'Denetim toplu yazimi basarisiz — kayitlar kuyruga geri konuyor',
      );
      // Kayıtları kaybetme: kuyruğun BAŞINA geri koy, sıra korunsun.
      this.queue.unshift(...batch);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Metadata'dan hassas alanları temizler.
   *
   * Denetim kaydı, korumaya çalıştığınız veriyi sızdıran ikinci bir kaynağa
   * dönüşmemelidir. "Rol değişti" kaydının içinde parola hash'i veya token
   * bulunması, sistemin en çok korunan tablosunu en zayıf halkaya çevirir.
   */
  private redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = /^(password|passwd|token|secret|key|authorization|cookie|ciphertext|body|content)$/iu;
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(metadata)) {
      if (sensitiveKeys.test(key)) {
        result[key] = '[REDACTED]';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.redactMetadata(value as Record<string, unknown>);
      } else if (typeof value === 'string' && value.length > 500) {
        // Uzun metinler denetim kaydında yeri yok — mesaj gövdesi olabilir.
        result[key] = `${value.slice(0, 100)}… [${value.length} karakter kirpildi]`;
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}
