import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { DatabaseService } from '../common/database/database.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { PresenceService } from '../presence/presence.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { ChannelKeyRepository } from '../common/crypto/channel-key.repository';

/**
 * Saklama Politikaları ve Planlı Bakım.
 *
 * SİLME STRATEJİSİ: `DROP PARTITION`, `DELETE` DEĞİL.
 *   50 milyon satırlık bir DELETE:
 *     · saatler sürer
 *     · WAL'i şişirir ve replikasyonu geciktirir
 *     · devasa tombstone birikimi ve VACUUM baskısı yaratır
 *     · tablo kilitleri nedeniyle canlı trafiği etkiler
 *   Aynı işin `DROP TABLE messages_2025_08` karşılığı SANİYELER sürer ve
 *   yalnızca metadata değiştirir.
 *
 * YASAL MUHAFAZA (legal hold) HER ŞEYİN ÜSTÜNDEDİR.
 *   Bir dava veya soruşturma sürerken veri silmek, teknik bir hata değil
 *   hukuki bir sorumluluktur (kanıt karartma). `legal_hold` bayrağı aktif
 *   olan hiçbir politika uygulanmaz.
 *
 * ÇOK REPLİKALI ÇALIŞMA
 *   Planlı görevler her replikada tetiklenir. Aynı temizliği 3 kez yapmak
 *   çakışma ve gereksiz yük üretir; bu yüzden PostgreSQL danışmanlık kilidi
 *   (advisory lock) ile yalnızca bir replika çalışır.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  /** Danışmanlık kilidi anahtarları — çakışmayı önlemek için sabit. */
  private static readonly LOCK_RETENTION = 4_010_001;
  private static readonly LOCK_SESSIONS = 4_010_002;
  private static readonly LOCK_KEYS = 4_010_003;
  private static readonly LOCK_AUDIT = 4_010_004;

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly presence: PresenceService,
    private readonly crypto: CryptoService,
    private readonly channelKeys: ChannelKeyRepository,
  ) {}

  // -------------------------------------------------------------------------
  //  Mesaj ve dosya saklama
  // -------------------------------------------------------------------------

  /** Her gece 03:00 — düşük trafik saatinde. */
  @Cron('0 3 * * *', { name: 'retention-purge', timeZone: 'Europe/Istanbul' })
  async purgeExpiredData(): Promise<void> {
    await this.withLock(RetentionService.LOCK_RETENTION, async () => {
      const purgedFiles = await this.purgeExpiredFiles();
      const droppedPartitions = await this.dropExpiredPartitions();

      if (purgedFiles > 0 || droppedPartitions.length > 0) {
        this.logger.log({ purgedFiles, droppedPartitions }, 'Saklama temizligi tamamlandi');
      }
    });
  }

  /**
   * Süresi dolmuş partition'ları düşürür.
   *
   * Politikalardaki EN UZUN TTL esas alınır: farklı kanalların farklı
   * saklama süreleri olabilir ve bir partition tüm kanalların mesajlarını
   * içerir. En uzun süre dolmadan partition düşürülemez.
   *
   * Kanal bazlı hassas silme gerekiyorsa (bir kanalın 30 gün, diğerinin
   * 7 yıl saklanması) partition yerine kanal bazlı DELETE gerekir — bu
   * durumda ayrı bir tablo alanına (tablespace) veya ayrı partition
   * hiyerarşisine geçilmelidir.
   */
  private async dropExpiredPartitions(): Promise<string[]> {
    const policy = await this.db.queryMaybe<{ max_ttl: number | null }>(
      `SELECT MAX(message_ttl_days) AS max_ttl
         FROM retention_policies
        WHERE legal_hold = false AND message_ttl_days IS NOT NULL`,
    );

    // Süresiz saklama politikası varsa veya hiç politika yoksa hiçbir şey silinmez.
    // Varsayılan davranışın "sakla" olması bilinçlidir: yanlışlıkla silinen
    // veri geri gelmez, yanlışlıkla saklanan veri sonra silinebilir.
    if (!policy?.max_ttl) return [];

    const hasUnlimited = await this.db.queryMaybe<{ id: string }>(
      `SELECT id FROM retention_policies WHERE message_ttl_days IS NULL OR legal_hold = true LIMIT 1`,
    );
    if (hasUnlimited) {
      this.logger.debug('Suresiz veya yasal muhafazali politika mevcut — partition dusurulmuyor');
      return [];
    }

    const cutoff = new Date(Date.now() - policy.max_ttl * 24 * 60 * 60 * 1000);

    // Tamamı kesim tarihinden ÖNCE biten partition'ları bul.
    const partitions = await this.db.query<{ partition_name: string; upper_bound: string }>(
      `SELECT c.relname AS partition_name,
              pg_get_expr(c.relpartbound, c.oid) AS upper_bound
         FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class parent ON parent.oid = i.inhparent
        WHERE parent.relname = 'messages'
          AND c.relname <> 'messages_default'`,
    );

    const dropped: string[] = [];

    for (const partition of partitions) {
      // Partition adından tarihi çıkar: messages_2025_08 → 2025-08
      const match = /_(\d{4})_(\d{2})$/u.exec(partition.partition_name);
      if (!match) continue;

      // Partition'ın BİTİŞ tarihi (bir sonraki ayın ilk günü) kesimden önce mi?
      const partitionEnd = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
      if (partitionEnd >= cutoff) continue;

      try {
        // DETACH CONCURRENTLY: uzun kilit almaz, canlı trafiği etkilemez.
        await this.db.query(
          `ALTER TABLE messages DETACH PARTITION ${partition.partition_name} CONCURRENTLY`,
        );
        await this.db.query(`DROP TABLE IF EXISTS ${partition.partition_name}`);

        dropped.push(partition.partition_name);
        this.logger.warn({ partition: partition.partition_name }, 'Saklama suresi dolan partition dusuruldu');
      } catch (error) {
        this.logger.error(
          { err: (error as Error).message, partition: partition.partition_name },
          'Partition dusurulemedi',
        );
      }
    }

    if (dropped.length > 0) {
      await this.audit.record({
        orgId: '00000000-0000-0000-0000-000000000000',
        action: 'retention.purge',
        resourceType: 'messages',
        metadata: { partitions: dropped, cutoff: cutoff.toISOString() },
      });
    }

    return dropped;
  }

  /**
   * Süresi dolmuş dosyaları işaretler.
   *
   * S3 nesnesi burada SİLİNMEZ: gerçek silme, `deleted_at` işaretli
   * kayıtları okuyan ayrı bir worker tarafından yapılır. İki adıma
   * ayrılmasının sebebi, S3 silmesinin geri alınamaz olması ve bir hata
   * durumunda veritabanı işleminin geri alınabilmesidir.
   */
  private async purgeExpiredFiles(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE attachments a
          SET deleted_at = now()
         FROM channels c
         LEFT JOIN retention_policies rp ON rp.id = c.retention_id
        WHERE a.channel_id = c.id
          AND a.deleted_at IS NULL
          AND COALESCE(rp.legal_hold, false) = false
          AND rp.file_ttl_days IS NOT NULL
          AND a.created_at < now() - (rp.file_ttl_days || ' days')::interval
        RETURNING a.id`,
    );

    for (const row of rows) {
      await this.db.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('attachment', $1, 'attachment.purge_requested', $2::jsonb)`,
        [row.id, JSON.stringify({ attachmentId: row.id })],
      );
    }

    return rows.length;
  }

  // -------------------------------------------------------------------------
  //  Diğer planlı bakım
  // -------------------------------------------------------------------------

  /** Süresi dolmuş oturum kayıtlarını temizler. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'session-prune' })
  async pruneSessions(): Promise<void> {
    await this.withLock(RetentionService.LOCK_SESSIONS, async () => {
      const pruned = await this.auth.pruneExpiredSessions();
      if (pruned > 0) this.logger.log({ pruned }, 'Suresi dolmus oturumlar temizlendi');
    });
  }

  /** 90 günden eski kanal anahtarlarını döndürür. */
  @Cron(CronExpression.EVERY_WEEK, { name: 'key-rotation' })
  async rotateOldKeys(): Promise<void> {
    await this.withLock(RetentionService.LOCK_KEYS, async () => {
      // Toplu rotasyon KMS'i boğmamalı: haftada 100 kanal, kademeli ilerler.
      const stale = await this.channelKeys.findKeysOlderThan(90, 100);

      for (const { channelId } of stale) {
        try {
          const version = await this.crypto.rotateChannelKey(channelId);
          await this.audit.record({
            orgId: '00000000-0000-0000-0000-000000000000',
            action: 'key.rotate',
            resourceType: 'channel',
            resourceId: channelId,
            metadata: { newVersion: version },
          });
        } catch (error) {
          // Tek bir kanalın başarısızlığı tüm rotasyonu durdurmamalı.
          this.logger.error(
            { err: (error as Error).message, channelId },
            'Anahtar rotasyonu basarisiz',
          );
        }
      }

      if (stale.length > 0) this.logger.log({ rotated: stale.length }, 'Kanal anahtarlari donduruldu');
    });
  }

  /**
   * Denetim zinciri doğrulaması.
   *
   * Kırılma tespiti = KRİTİK ALARM. Bu görev sessizce başarısız olmamalıdır;
   * izleme sistemi bu görevin ÇALIŞTIĞINI da doğrulamalıdır (dead man's switch).
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM, { name: 'audit-chain-verify' })
  async verifyAuditChains(): Promise<void> {
    await this.withLock(RetentionService.LOCK_AUDIT, async () => {
      const orgs = await this.db.query<{ id: string }>(
        'SELECT id FROM organizations WHERE is_active = true',
      );

      const to = new Date();
      const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);

      for (const org of orgs) {
        const result = await this.audit.verifyChain(org.id, from, to);
        if (!result.valid) {
          this.logger.error(
            { orgId: org.id, brokenAt: result.brokenAt },
            'KRITIK: denetim zinciri kirik — derhal inceleme gerekli',
          );
        }
      }
    });
  }

  /** Süresi dolmuş özel durum mesajlarını temizler. */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'presence-status-cleanup' })
  async clearExpiredStatuses(): Promise<void> {
    const cleared = await this.presence.clearExpiredStatuses();
    if (cleared > 0) this.logger.debug({ cleared }, 'Suresi dolmus durumlar temizlendi');
  }

  /** Gelecek 3 ay için partition üretir. */
  @Cron('0 2 1 * *', { name: 'partition-create', timeZone: 'Europe/Istanbul' })
  async ensureFuturePartitions(): Promise<void> {
    await this.withLock(RetentionService.LOCK_RETENTION, async () => {
      const now = new Date();

      for (let offset = 0; offset < 4; offset += 1) {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
        const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
        const suffix = `${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`;

        for (const table of ['messages', 'audit_logs']) {
          try {
            await this.db.query(
              `CREATE TABLE IF NOT EXISTS ${table}_${suffix}
               PARTITION OF ${table}
               FOR VALUES FROM ('${start.toISOString().slice(0, 10)}') TO ('${end.toISOString().slice(0, 10)}')`,
            );
          } catch (error) {
            // Partition zaten varsa veya varsayılan partition'da veri
            // bulunduğu için oluşturulamıyorsa loglanır ve devam edilir.
            this.logger.debug(
              { err: (error as Error).message, table, suffix },
              'Partition olusturulamadi (muhtemelen zaten var)',
            );
          }
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  /**
   * PostgreSQL danışmanlık kilidi ile tek replikada çalışma garantisi.
   *
   * `pg_try_advisory_lock` BLOKLAMAZ: kilidi alamayan replika sessizce
   * geçer. Bloklayan sürüm (`pg_advisory_lock`) kullanılsaydı, üç replika
   * sırayla aynı işi tekrarlardı.
   *
   * Kilit AYNI BAĞLANTIDA açılmalıdır — bu yüzden transaction kullanılır.
   */
  private async withLock(lockKey: number, fn: () => Promise<void>): Promise<void> {
    try {
      await this.db.transaction(async (client) => {
        const result = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1) AS locked',
          [lockKey],
        );

        if (!result.rows[0].locked) {
          this.logger.debug({ lockKey }, 'Gorev baska bir replikada calisiyor — atlandi');
          return;
        }

        await fn();
      });
    } catch (error) {
      // Planlı görev hatası uygulamayı düşürmemeli, ama görünmez de olmamalı.
      this.logger.error(
        { err: (error as Error).message, lockKey },
        'Planli gorev basarisiz',
      );
    }
  }
}
