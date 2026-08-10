import { Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '../common/database/database.service';
import { RedisService } from '../common/redis/redis.service';

/**
 * Kullanıcı Güvenlik Durumu Önbelleği.
 *
 * NE İÇİN?
 *   JwtAuthGuard her istekte `token_version` ve hesap durumunu kontrol eder.
 *   Bu, JWT'ye iptal edilebilirlik kazandıran mekanizmadır — ama her istekte
 *   PostgreSQL'e gitmek, JWT kullanmanın tüm performans gerekçesini ortadan
 *   kaldırır.
 *
 * İKİ KATMANLI ÖNBELLEK
 *   L1 (süreç içi, 5 sn)  → aynı kullanıcının ardışık istekleri
 *   L2 (Redis, 30 sn)     → düğümler arası paylaşım
 *
 * TUTARLILIK SÖZÜ
 *   Bir rol değişikliği en fazla 5 saniye içinde etkili olur. Bu pencere
 *   kabul edilebilir görülmüyorsa `invalidate()` çağrısı L1 ve L2'yi birlikte
 *   temizler ve etki ANINDA olur — AuthService bunu her yetki değişiminde yapar.
 *   TTL bir güvenlik ağıdır, birincil mekanizma değildir.
 */

export interface UserSecurityRecord {
  userId: string;
  orgId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED';
  tokenVersion: number;
  email: string;
}

const L1_TTL_MS = 5_000;
const L2_TTL_SECONDS = 30;
const L1_MAX_ENTRIES = 10_000;

@Injectable()
export class UserSecurityCache {
  private readonly logger = new Logger(UserSecurityCache.name);
  private readonly l1 = new Map<string, { record: UserSecurityRecord | null; expiresAt: number }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async get(userId: string): Promise<UserSecurityRecord | null> {
    const now = Date.now();

    // --- L1 ---
    const local = this.l1.get(userId);
    if (local && local.expiresAt > now) return local.record;

    // --- L2 ---
    try {
      const cached = await this.redis.get(this.key(userId));
      if (cached !== null) {
        // Boş dize = "kullanıcı yok" (negatif önbellek). Geçersiz bir
        // userId ile yapılan ısrarlı denemeler her seferinde DB'ye inmesin.
        const record = cached === '' ? null : (JSON.parse(cached) as UserSecurityRecord);
        this.setL1(userId, record);
        return record;
      }
    } catch (error) {
      // Redis düşmüşse doğrudan veritabanına git — yetkilendirme durmaz.
      this.logger.warn({ err: (error as Error).message }, 'L2 onbellek okunamadi');
    }

    // --- Kaynak ---
    const record = await this.loadFromDb(userId);

    this.setL1(userId, record);
    try {
      await this.redis.setex(this.key(userId), L2_TTL_SECONDS, record ? JSON.stringify(record) : '');
    } catch {
      // Önbellek yazımı en iyi çabadır.
    }

    return record;
  }

  /**
   * Önbelleği anında temizler.
   *
   * ÇAĞRILMASI ZORUNLU OLAN DURUMLAR:
   *   · Rol veya izin değişimi
   *   · Parola değişimi
   *   · Hesap askıya alma / kaldırma
   *   · "Tüm cihazlardan çıkış"
   *
   * Bu çağrı atlanırsa, yetkisi alınmış bir kullanıcı 30 saniye daha
   * eski yetkileriyle çalışmaya devam eder.
   */
  async invalidate(userId: string): Promise<void> {
    this.l1.delete(userId);
    try {
      await this.redis.del(this.key(userId));
    } catch (error) {
      this.logger.error(
        { err: (error as Error).message, userId },
        'ONBELLEK TEMIZLENEMEDI — eski yetkiler 30 sn daha gecerli kalabilir',
      );
    }
  }

  /**
   * Token sürümünü artırır ve önbelleği temizler.
   * Kullanıcının dolaşımdaki TÜM erişim token'ları anında geçersizleşir.
   */
  async bumpTokenVersion(userId: string): Promise<number> {
    const result = await this.db.queryOne<{ token_version: number }>(
      'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version',
      [userId],
      'Kullanici bulunamadi',
    );

    await this.invalidate(userId);
    this.logger.log({ userId, tokenVersion: result.token_version }, 'Token surumu artirildi');
    return result.token_version;
  }

  private async loadFromDb(userId: string): Promise<UserSecurityRecord | null> {
    const row = await this.db.queryMaybe<{
      id: string;
      org_id: string;
      status: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED';
      token_version: number;
      email: string;
    }>(
      `SELECT id, org_id, status, token_version, email
         FROM users
        WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );

    if (!row) return null;

    return {
      userId: row.id,
      orgId: row.org_id,
      status: row.status,
      tokenVersion: row.token_version,
      email: row.email,
    };
  }

  private setL1(userId: string, record: UserSecurityRecord | null): void {
    // En eski girişi düşür (Map ekleme sırasını korur).
    if (this.l1.size >= L1_MAX_ENTRIES) {
      const oldest = this.l1.keys().next();
      if (!oldest.done) this.l1.delete(oldest.value);
    }
    this.l1.set(userId, { record, expiresAt: Date.now() + L1_TTL_MS });
  }

  private key(userId: string): string {
    return `usec:${userId}`;
  }
}
