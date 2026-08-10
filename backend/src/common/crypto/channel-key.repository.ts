import { Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

export interface ChannelKeyRecord {
  id: string;
  channelId: string;
  version: number;
  wrappedDek: Buffer;
  kekId: string;
  algorithm: string;
  isActive: boolean;
  createdAt: Date;
}

/**
 * Kanal Şifreleme Anahtarları.
 *
 * Bu tablodaki `wrapped_dek` KMS/Vault ile sarmalanmıştır. Veritabanını ele
 * geçiren biri bu sütunu okusa bile, KMS erişimi olmadan hiçbir mesajı
 * çözemez. Zarf şifrelemenin tüm değeri buradadır: koruma sınırı
 * veritabanından KMS'e taşınır.
 */
@Injectable()
export class ChannelKeyRepository {
  private readonly logger = new Logger(ChannelKeyRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async findActive(channelId: string): Promise<ChannelKeyRecord | null> {
    const raw = await this.db.queryMaybe<{
      id: string;
      channel_id: string;
      version: number;
      wrapped_dek: Buffer;
      kek_id: string;
      algorithm: string;
      is_active: boolean;
      created_at: Date;
    }>(
      `SELECT id, channel_id, version, wrapped_dek, kek_id, algorithm, is_active, created_at
         FROM channel_keys
        WHERE channel_id = $1 AND is_active = true`,
      [channelId],
    );
    return raw ? this.toRecord(raw) : null;
  }

  /** Rotasyon sonrası eski mesajları çözmek için belirli bir sürümü getirir. */
  async findByVersion(channelId: string, version: number): Promise<ChannelKeyRecord | null> {
    const raw = await this.db.queryMaybe<{
      id: string;
      channel_id: string;
      version: number;
      wrapped_dek: Buffer;
      kek_id: string;
      algorithm: string;
      is_active: boolean;
      created_at: Date;
    }>(
      `SELECT id, channel_id, version, wrapped_dek, kek_id, algorithm, is_active, created_at
         FROM channel_keys
        WHERE channel_id = $1 AND version = $2`,
      [channelId, version],
    );
    return raw ? this.toRecord(raw) : null;
  }

  /**
   * Yeni anahtar sürümü ekler ve öncekini pasifleştirir.
   *
   * ESKİ ANAHTAR SİLİNMEZ. Silmek, o anahtarla şifrelenmiş tüm geçmişi
   * kalıcı olarak okunamaz hale getirir. Kasıtlı bir "crypto-shredding"
   * (anahtarı imha ederek veriyi yok etme) gerekiyorsa, bu ayrı ve
   * onay gerektiren bir işlem olmalıdır — rotasyonun yan etkisi değil.
   */
  async insertNewVersion(channelId: string, wrappedDek: Buffer): Promise<number> {
    return this.db.transaction(async (client) => {
      // Kısmi benzersiz indeks (uq_channel_keys_active) kanal başına tek
      // aktif anahtara izin verir; önce pasifleştirmek zorunludur.
      await client.query(
        'UPDATE channel_keys SET is_active = false, rotated_at = now() WHERE channel_id = $1 AND is_active = true',
        [channelId],
      );

      const result = await client.query<{ version: number }>(
        `INSERT INTO channel_keys (channel_id, version, wrapped_dek, kek_id, is_active)
         SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, true
           FROM channel_keys WHERE channel_id = $1
         RETURNING version`,
        [channelId, wrappedDek, process.env.AWS_KMS_KEY_ID ?? 'local'],
      );

      const version = result.rows[0].version;
      this.logger.log({ channelId, version }, 'Yeni kanal anahtar surumu olusturuldu');
      return version;
    });
  }

  /** Rotasyon zamanı gelmiş kanallar — planlı görev bunu kullanır. */
  async findKeysOlderThan(days: number, limit = 100): Promise<Array<{ channelId: string; version: number }>> {
    const rows = await this.db.query<{ channel_id: string; version: number }>(
      `SELECT channel_id, version FROM channel_keys
        WHERE is_active = true AND created_at < now() - ($1 || ' days')::interval
        ORDER BY created_at ASC
        LIMIT $2`,
      [days, limit],
    );
    return rows.map((r) => ({ channelId: r.channel_id, version: r.version }));
  }

  private toRecord(raw: {
    id: string;
    channel_id: string;
    version: number;
    wrapped_dek: Buffer;
    kek_id: string;
    algorithm: string;
    is_active: boolean;
    created_at: Date;
  }): ChannelKeyRecord {
    return {
      id: raw.id,
      channelId: raw.channel_id,
      version: raw.version,
      wrappedDek: raw.wrapped_dek,
      kekId: raw.kek_id,
      algorithm: raw.algorithm,
      isActive: raw.is_active,
      createdAt: raw.created_at,
    };
  }
}
