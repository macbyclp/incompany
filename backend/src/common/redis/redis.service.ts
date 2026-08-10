import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';

/**
 * Redis Erişim Katmanı.
 *
 * ÜÇ AYRI BAĞLANTI KULLANILIR — bu bir israf değil, zorunluluktur:
 *   · `client`     — normal komutlar
 *   · `subscriber` — abonelik modundaki bir bağlantı BAŞKA komut kabul etmez
 *   · `publisher`  — yayın; abonelik bağlantısından ayrı olmalı
 *
 * Tek bağlantıda hem SUBSCRIBE hem GET yapmaya çalışmak, Redis protokolü
 * gereği hata verir. Bu, ilk kez pub/sub ekleyen ekiplerin klasik tuzağıdır.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  private client!: Redis;
  private subscriber!: Redis;
  private publisher!: Redis;

  private readonly keyspaceHandlers = new Map<string, (key: string) => void>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.getOrThrow<string>('REDIS_URL');

    const options: RedisOptions = {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      // Bağlantı yokken komut kuyruklamayı KAPAT. Açık bırakılırsa uzun bir
      // kesintide kuyruk sınırsız büyür ve süreç OOM ile ölür.
      enableOfflineQueue: false,
      // Üstel geri çekilme, 3 sn tavanlı.
      retryStrategy: (times) => Math.min(times * 200, 3_000),
      // Yeniden bağlanma sırasında READONLY hatası alınırsa (failover) yeniden dene.
      reconnectOnError: (error) => error.message.includes('READONLY'),
      lazyConnect: false,
    };

    this.client = new Redis(url, options);
    this.subscriber = new Redis(url, options);
    this.publisher = new Redis(url, options);

    for (const [name, connection] of Object.entries({
      client: this.client,
      subscriber: this.subscriber,
      publisher: this.publisher,
    })) {
      connection.on('error', (error) =>
        this.logger.error({ connection: name, err: error.message }, 'Redis baglanti hatasi'),
      );
      connection.on('ready', () => this.logger.log(`Redis '${name}' baglantisi hazir`));
    }

    this.bindKeyspaceNotifications();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.client?.quit(),
      this.subscriber?.quit(),
      this.publisher?.quit(),
    ]);
  }

  /** Socket.IO adapter'ı ve gelişmiş kullanımlar için ham istemci. */
  get raw(): Redis {
    return this.client;
  }

  // -------------------------------------------------------------------------
  //  Anahtar/değer
  // -------------------------------------------------------------------------

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string): Promise<'OK'> {
    return this.client.set(key, value);
  }

  async setex(key: string, seconds: number, value: string): Promise<'OK'> {
    return this.client.setex(key, seconds, value);
  }

  /**
   * Atomik "yoksa yaz" — TTL ile birlikte.
   *
   * İdempotency talebinin temelidir: `SET key value EX ttl NX` tek bir
   * atomik işlemdir. `EXISTS` + `SET` olarak ayrılırsa, iki eşzamanlı
   * yeniden gönderim arasında yarış oluşur ve ikisi de talebi kazanır.
   *
   * @returns Talep kazanıldıysa 'OK', anahtar zaten varsa null.
   */
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<'OK' | null> {
    return this.client.set(key, value, 'EX', ttlSeconds, 'NX');
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    // Pipeline: iki gidiş-dönüş yerine bir tane.
    const results = await this.client.multi().incr(key).expire(key, ttlSeconds, 'NX').exec();
    return (results?.[0]?.[1] as number) ?? 0;
  }

  // -------------------------------------------------------------------------
  //  Küme (set) — presence ve typing için
  // -------------------------------------------------------------------------

  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.client.sadd(key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return this.client.srem(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async scard(key: string): Promise<number> {
    return this.client.scard(key);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  // -------------------------------------------------------------------------
  //  Hash — presence durumu
  // -------------------------------------------------------------------------

  async hset(key: string, values: Record<string, string>): Promise<number> {
    return this.client.hset(key, values);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  // -------------------------------------------------------------------------
  //  Pub/Sub
  // -------------------------------------------------------------------------

  async publish(channel: string, message: string): Promise<number> {
    return this.publisher.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (receivedChannel, message) => {
      if (receivedChannel === channel) handler(message);
    });
  }

  /**
   * Anahtar süre dolumu bildirimlerini dinler.
   *
   * PRESENCE İÇİN KRİTİK: bir kullanıcının kalp atışı kesildiğinde
   * `presence:{userId}` anahtarının TTL'i dolar ve Redis bunu bildirir.
   * Bu mekanizma olmadan çevrimdışı tespiti için sürekli tarama (polling)
   * gerekir — 10.000 kullanıcıda kabul edilemez.
   *
   * Gereklilik: `notify-keyspace-events Ex` (docker-compose'da açık).
   */
  onKeyExpired(prefix: string, handler: (key: string) => void): void {
    this.keyspaceHandlers.set(prefix, handler);
  }

  private bindKeyspaceNotifications(): void {
    const pattern = '__keyevent@0__:expired';

    this.subscriber.psubscribe(pattern).catch((error) => {
      this.logger.error(
        { err: (error as Error).message },
        'Keyspace bildirimlerine abone olunamadi — presence zaman asimi calismaz',
      );
    });

    this.subscriber.on('pmessage', (_pattern, _channel, expiredKey: string) => {
      for (const [prefix, handler] of this.keyspaceHandlers) {
        if (expiredKey.startsWith(prefix)) {
          try {
            handler(expiredKey);
          } catch (error) {
            this.logger.error(
              { err: (error as Error).message, key: expiredKey },
              'Keyspace isleyicisi hata verdi',
            );
          }
          break;
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  //  Lua betikleri
  // -------------------------------------------------------------------------

  /**
   * Lua betiği çalıştırır. `EVALSHA` ile önbellekten, yoksa `EVAL` ile.
   *
   * Betiğin atomikliği ÖNEMLİDİR: rate limit ve idempotency gibi
   * "oku-karar-ver-yaz" işlemleri, ayrı komutlarla yapılırsa yarış koşulu
   * yaratır ve sınırlar aşılır.
   */
  async evalScript<T>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
    return this.client.eval(script, keys.length, ...keys, ...args) as Promise<T>;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.client.ping();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
