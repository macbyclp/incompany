import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { RedisService } from '../redis/redis.service';

/**
 * Kayan Pencere (Sliding Window) Rate Limiter.
 *
 * NEDEN KAYAN PENCERE, SABİT PENCERE DEĞİL?
 *   Sabit pencerede (`INCR` + `EXPIRE`) sınır, pencere sınırında ikiye
 *   katlanır: 10 sn'lik pencerede 20 hakkı olan biri, 9. saniyede 20 ve
 *   11. saniyede 20 daha gönderebilir — 2 saniyede 40 mesaj. Kayan pencere
 *   bu boşluğu kapatır.
 *
 * ATOMİKLİK
 *   Tüm mantık tek bir Lua betiğindedir. "Say → karşılaştır → ekle" adımlarını
 *   ayrı komutlarla yapmak, eşzamanlı isteklerde sınırın aşılmasına yol açar.
 *   Redis Lua betikleri atomik çalışır; arada başka komut araya giremez.
 */

export interface RateLimitOptions {
  /** Pencere başına izin verilen işlem sayısı. */
  points: number;
  /** Pencere uzunluğu (saniye). */
  durationSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * KEYS[1] = sıralı küme anahtarı
 * ARGV[1] = şimdi (ms)
 * ARGV[2] = pencere (ms)
 * ARGV[3] = limit
 * ARGV[4] = benzersiz üye kimliği
 *
 * Üye kimliği ISTEMCIDEN gelir; Lua'nın `math.random`'ı replikasyon
 * güvenliği için deterministik tohumlanır ve aynı ms içindeki iki istek
 * aynı üyeyi üretip birbirinin üzerine yazabilir.
 */
const SLIDING_WINDOW_SCRIPT = `
local key       = KEYS[1]
local now       = tonumber(ARGV[1])
local window    = tonumber(ARGV[2])
local limit     = tonumber(ARGV[3])
local member    = ARGV[4]

-- Pencere dışında kalan kayıtları temizle
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  -- TTL her eklemede tazelenir: anahtar sonsuza kadar yaşamasın
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end

-- Sınır aşıldı: en eski kaydın ne zaman düşeceğini hesapla
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retryAfterMs = (tonumber(oldest[2]) + window) - now
if retryAfterMs < 0 then retryAfterMs = 0 end

return {0, 0, math.ceil(retryAfterMs / 1000)}
`;

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Bir işlem hakkı tüketir.
   *
   * ARIZA DURUŞU: FAIL-OPEN.
   *   Redis erişilemezse istek GEÇİRİLİR. Bu bilinçli bir takastır: bir
   *   önbellek arızasının tüm mesajlaşmayı durdurması, kısa süreli sınırsız
   *   trafiğe izin vermekten daha kötüdür. Kimlik doğrulama ve ödeme gibi
   *   yollarda tercih TERSİNE çevrilmelidir (fail-closed) — bkz. `consumeStrict`.
   */
  async consume(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    try {
      return await this.execute(key, options);
    } catch (error) {
      this.logger.warn(
        { err: (error as Error).message, key },
        'Rate limit kontrolu atlandi — Redis erisilemez (fail-open)',
      );
      return { ok: true, remaining: options.points, retryAfterSec: 0 };
    }
  }

  /**
   * Fail-closed varyant. Redis erişilemezse istek REDDEDİLİR.
   * Giriş denemeleri, parola sıfırlama ve dosya indirme gibi kötüye
   * kullanımı pahalı yollarda kullanılır.
   */
  async consumeStrict(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    try {
      return await this.execute(key, options);
    } catch (error) {
      this.logger.error(
        { err: (error as Error).message, key },
        'Rate limit kontrolu basarisiz — istek reddedildi (fail-closed)',
      );
      return { ok: false, remaining: 0, retryAfterSec: options.durationSec };
    }
  }

  /** Hak tüketmeden mevcut durumu okur (arayüzde sayaç göstermek için). */
  async peek(key: string, options: RateLimitOptions): Promise<number> {
    const now = Date.now();
    const windowMs = options.durationSec * 1_000;
    const redisKey = this.buildKey(key);

    try {
      await this.redis.raw.zremrangebyscore(redisKey, 0, now - windowMs);
      const used = await this.redis.raw.zcard(redisKey);
      return Math.max(options.points - used, 0);
    } catch {
      return options.points;
    }
  }

  /** Sınırı sıfırlar — başarılı girişten sonra giriş denemesi sayacını temizler. */
  async reset(key: string): Promise<void> {
    await this.redis.del(this.buildKey(key));
  }

  private async execute(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    const [allowed, remaining, retryAfter] = await this.redis.evalScript<[number, number, number]>(
      SLIDING_WINDOW_SCRIPT,
      [this.buildKey(key)],
      [Date.now(), options.durationSec * 1_000, options.points, randomUUID()],
    );

    return {
      ok: allowed === 1,
      remaining,
      // Sıfır saniye beklemek anlamsız bir yanıttır; en az 1 sn dön.
      retryAfterSec: Math.max(retryAfter, allowed === 1 ? 0 : 1),
    };
  }

  private buildKey(key: string): string {
    return `rl:${key}`;
  }
}

/**
 * Sistem genelinde kullanılan sınır profilleri.
 *
 * Tek yerde toplanmalarının sebebi: bu sayılar dağınık halde yazıldığında
 * kimse tümüne bakıp tutarlı olup olmadıklarını değerlendiremez.
 */
export const RATE_LIMITS = {
  /** Mesaj gönderimi — insan yazma hızının çok üstünde, bot hızının altında. */
  MESSAGE_SEND: { points: 20, durationSec: 10 },
  /** Yeniden bağlanma sonrası senkronizasyon — pahalı olduğu için dar. */
  CHANNEL_SYNC: { points: 10, durationSec: 30 },
  /** Giriş denemesi — kaba kuvvet koruması, fail-closed kullanılmalı. */
  LOGIN: { points: 5, durationSec: 300 },
  /** Token yenileme. */
  TOKEN_REFRESH: { points: 30, durationSec: 300 },
  /** Dosya yükleme. */
  FILE_UPLOAD: { points: 30, durationSec: 60 },
  /** Dosya indirme — toplu sızdırmayı yavaşlatır. */
  FILE_DOWNLOAD: { points: 100, durationSec: 3600 },
  /** Arama — pahalı sorgu. */
  SEARCH: { points: 30, durationSec: 60 },
  /** Genel HTTP API. */
  API_DEFAULT: { points: 300, durationSec: 60 },
} as const satisfies Record<string, RateLimitOptions>;
