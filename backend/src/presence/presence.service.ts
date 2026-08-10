import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PresenceStatus } from '@incompany/contracts';

import { RedisService } from '../common/redis/redis.service';
import { DatabaseService } from '../common/database/database.service';

/**
 * Varlık (Presence) Yönetimi.
 *
 * TEMEL İLKE: `disconnect` OLAYINA GÜVENİLMEZ.
 *   Dizüstü kapağı kapandığında, mobil ağ değiştiğinde, süreç `SIGKILL`
 *   aldığında veya kablo çekildiğinde bu olay HİÇ GELMEZ. Yalnızca ona
 *   dayanan bir sistem, saatlerce "çevrimiçi" görünen hayalet kullanıcılarla
 *   dolar.
 *
 *   Bunun yerine TTL modeli: istemci 25 sn'de bir kalp atışı gönderir,
 *   Redis anahtarı 45 sn TTL ile tazelenir. Kalp atışı kesilirse anahtar
 *   kendiliğinden düşer ve keyspace bildirimi çevrimdışı yayınını tetikler.
 *   2:1 oranı, tek bir paket kaybının kullanıcıyı yanlışlıkla düşürmesini önler.
 *
 * ÇOKLU CİHAZ
 *   `sockets:{userId}` bir SET'tir. Kullanıcı ancak set boşaldığında
 *   çevrimdışı olur — telefon açıkken masaüstünü kapatmak onu çevrimdışı yapmaz.
 */

export interface PresenceState {
  userId: string;
  orgId: string;
  status: PresenceStatus;
  customText?: string;
  customEmoji?: string;
  lastSeenAt: string;
}

/** Gateway tarafından kaydedilen yayın fonksiyonu — dairesel bağımlılık olmadan. */
export type PresenceBroadcaster = (state: PresenceState) => void;

const PRESENCE_TTL_SECONDS = 45;
const SOCKET_SET_TTL_SECONDS = 120;
const PRESENCE_KEY_PREFIX = 'presence:';

@Injectable()
export class PresenceService implements OnModuleInit {
  private readonly logger = new Logger(PresenceService.name);
  private broadcaster: PresenceBroadcaster | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    // TTL dolduğunda çevrimdışı yayını yap. Tarama (polling) yerine bildirim
    // kullanmak, 10.000 kullanıcıda saniyede binlerce gereksiz sorgudan kurtarır.
    this.redis.onKeyExpired(PRESENCE_KEY_PREFIX, (expiredKey) => {
      const userId = expiredKey.slice(PRESENCE_KEY_PREFIX.length);
      void this.handleExpiry(userId);
    });
  }

  /** ChatGateway.afterInit() tarafından çağrılır. */
  setBroadcaster(broadcaster: PresenceBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  // -------------------------------------------------------------------------
  //  Socket yaşam döngüsü
  // -------------------------------------------------------------------------

  async registerSocket(userId: string, socketId: string, orgId: string): Promise<void> {
    const socketsKey = this.socketsKey(userId);

    await Promise.all([
      this.redis.sadd(socketsKey, socketId),
      // Set'e de TTL: bir gateway çökerse orada kalan socket kimlikleri
      // sonsuza kadar birikmesin.
      this.redis.expire(socketsKey, SOCKET_SET_TTL_SECONDS),
      this.writeState(userId, { userId, orgId, status: PresenceStatus.ONLINE, lastSeenAt: new Date().toISOString() }),
    ]);
  }

  /** @returns Kullanıcının kalan açık socket sayısı. 0 ise çevrimdışı olmuştur. */
  async unregisterSocket(userId: string, socketId: string): Promise<number> {
    const socketsKey = this.socketsKey(userId);
    await this.redis.srem(socketsKey, socketId);
    const remaining = await this.redis.scard(socketsKey);

    if (remaining === 0) {
      await this.redis.del(this.presenceKey(userId), socketsKey);
      // `last_seen_at` kalıcı olarak yazılır: "3 saat önce görüldü"
      // bilgisi Redis TTL'ini aşan bir veridir.
      await this.persistLastSeen(userId);
    }

    return remaining;
  }

  /** Kalp atışı — TTL'i tazeler. */
  async refresh(userId: string, socketId: string): Promise<void> {
    const socketsKey = this.socketsKey(userId);

    try {
      await Promise.all([
        this.redis.expire(this.presenceKey(userId), PRESENCE_TTL_SECONDS),
        this.redis.sadd(socketsKey, socketId),
        this.redis.expire(socketsKey, SOCKET_SET_TTL_SECONDS),
      ]);
    } catch (error) {
      // Kalp atışının başarısızlığı bağlantıyı düşürmemeli — bir sonraki
      // atış büyük olasılıkla başarılı olur.
      this.logger.warn({ err: (error as Error).message, userId }, 'Kalp atisi tazeleme basarisiz');
    }
  }

  async getUserSockets(userId: string): Promise<string[]> {
    return this.redis.smembers(this.socketsKey(userId));
  }

  // -------------------------------------------------------------------------
  //  Durum
  // -------------------------------------------------------------------------

  async get(userId: string): Promise<PresenceState | null> {
    const raw = await this.redis.hgetall(this.presenceKey(userId));
    if (!raw || Object.keys(raw).length === 0) return null;

    return {
      userId,
      orgId: raw.orgId,
      status: raw.status as PresenceStatus,
      customText: raw.customText || undefined,
      customEmoji: raw.customEmoji || undefined,
      lastSeenAt: raw.lastSeenAt,
    };
  }

  /** Birden çok kullanıcının durumu — kenar çubuğu ve üye listesi için. */
  async getMany(userIds: readonly string[]): Promise<Map<string, PresenceState>> {
    if (userIds.length === 0) return new Map();

    const pipeline = this.redis.raw.pipeline();
    for (const userId of userIds) pipeline.hgetall(this.presenceKey(userId));

    const results = await pipeline.exec();
    const map = new Map<string, PresenceState>();

    results?.forEach(([error, data], index) => {
      if (error || !data) return;
      const raw = data as Record<string, string>;
      if (Object.keys(raw).length === 0) return;

      map.set(userIds[index], {
        userId: userIds[index],
        orgId: raw.orgId,
        status: raw.status as PresenceStatus,
        customText: raw.customText || undefined,
        customEmoji: raw.customEmoji || undefined,
        lastSeenAt: raw.lastSeenAt,
      });
    });

    return map;
  }

  /**
   * Kullanıcının elle ayarladığı durum (Meşgul, Dışarıda, özel mesaj).
   *
   * Manuel durum Redis'te TUTULUR ama veritabanına da yazılır: "Yıllık izinde,
   * 15 Ağustos'ta dönüyorum" bilgisi bir TTL'e bağlı olamaz — kullanıcı
   * çevrimdışıyken de görünmelidir.
   */
  async setManualStatus(
    userId: string,
    input: {
      status: PresenceStatus;
      customText?: string;
      customEmoji?: string;
      until?: Date;
    },
  ): Promise<void> {
    const existing = await this.get(userId);

    await this.writeState(userId, {
      userId,
      orgId: existing?.orgId ?? '',
      status: input.status,
      customText: input.customText,
      customEmoji: input.customEmoji,
      lastSeenAt: new Date().toISOString(),
    });

    await this.db.query(
      `UPDATE users
          SET presence = $2, custom_status_text = $3,
              custom_status_emoji = $4, custom_status_until = $5
        WHERE id = $1`,
      [userId, input.status, input.customText ?? null, input.customEmoji ?? null, input.until ?? null],
    );
  }

  /** Süresi dolmuş özel durumları temizler — planlı görev (5 dk). */
  async clearExpiredStatuses(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE users
          SET custom_status_text = NULL, custom_status_emoji = NULL,
              custom_status_until = NULL, presence = 'ONLINE'
        WHERE custom_status_until IS NOT NULL AND custom_status_until <= now()
        RETURNING id`,
    );

    for (const row of rows) {
      const state = await this.get(row.id);
      if (state) {
        await this.writeState(row.id, { ...state, status: PresenceStatus.ONLINE, customText: undefined });
        this.broadcaster?.({ ...state, status: PresenceStatus.ONLINE, customText: undefined });
      }
    }

    return rows.length;
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  private async writeState(userId: string, state: PresenceState): Promise<void> {
    const key = this.presenceKey(userId);

    await this.redis.hset(key, {
      orgId: state.orgId,
      status: state.status,
      customText: state.customText ?? '',
      customEmoji: state.customEmoji ?? '',
      lastSeenAt: state.lastSeenAt,
    });
    // TTL, hset'ten SONRA verilir: hset TTL'i sıfırlar.
    await this.redis.expire(key, PRESENCE_TTL_SECONDS);
  }

  /**
   * TTL doldu — kullanıcının kalp atışı kesildi.
   *
   * Yine de socket set'i kontrol edilir: nadir bir yarış koşulunda presence
   * anahtarı düşerken kullanıcının hâlâ açık bir socket'i olabilir.
   */
  private async handleExpiry(userId: string): Promise<void> {
    try {
      const remaining = await this.redis.scard(this.socketsKey(userId));
      if (remaining > 0) {
        this.logger.debug({ userId, remaining }, 'Presence TTL doldu ama acik socket var — yeniden yaziliyor');
        const state = await this.get(userId);
        if (state) await this.writeState(userId, state);
        return;
      }

      await this.persistLastSeen(userId);
      this.broadcaster?.({
        userId,
        orgId: '',
        status: PresenceStatus.OFFLINE,
        lastSeenAt: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error({ err: (error as Error).message, userId }, 'Presence sona erme islemi basarisiz');
    }
  }

  private async persistLastSeen(userId: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE users SET last_seen_at = now(), presence = 'OFFLINE' WHERE id = $1`,
        [userId],
      );
    } catch (error) {
      this.logger.warn({ err: (error as Error).message, userId }, 'last_seen_at yazilamadi');
    }
  }

  private presenceKey(userId: string): string {
    return `${PRESENCE_KEY_PREFIX}${userId}`;
  }

  private socketsKey(userId: string): string {
    return `sockets:${userId}`;
  }
}
