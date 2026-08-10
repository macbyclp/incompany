import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { RedisService } from '../common/redis/redis.service';

/**
 * "Yazıyor…" Göstergesi.
 *
 * İKİ TASARIM KURALI
 *
 * 1) HİÇBİR ŞEY KALICI DEĞİL.
 *    Yazıyor bilgisi saniyeler içinde değersizleşir. Veritabanına yazmak,
 *    mesaj yazımından kat kat fazla I/O üretir ve hiçbir işe yaramaz.
 *    Redis SET + 5 sn TTL yeterli ve doğru araçtır.
 *
 * 2) YAYIN TOPLU (BATCHED) YAPILIR — TUŞ BAŞINA DEĞİL.
 *    50 kişilik bir kanalda herkes yazarken tuş başına yayın, saniyede
 *    binlerce event demektir. Bunun yerine 1 sn'lik pencerelerde SET'in
 *    tamamı okunur ve tek bir `typing:update` gönderilir.
 *
 *    Kullanıcı deneyimi kaybı yok: 1 sn'lik gecikme, göstergenin doğası
 *    gereği fark edilmez. Kaynak kazancı ise iki kat büyüklüktedir.
 */

export type TypingBroadcaster = (channelId: string, userIds: string[]) => void;

/** SET TTL'i — kullanıcı yazmayı bırakırsa gösterge kendiliğinden söner. */
const TYPING_TTL_SECONDS = 5;
/** Yayın penceresi. */
const FLUSH_INTERVAL_MS = 1_000;
/** Aynı anda izlenecek en fazla kanal — bellek koruması. */
const MAX_TRACKED_CHANNELS = 5_000;

@Injectable()
export class TypingService implements OnModuleDestroy {
  private readonly logger = new Logger(TypingService.name);
  private broadcaster: TypingBroadcaster | null = null;

  /** Bu pencerede değişen kanallar — yalnızca bunlar için yayın yapılır. */
  private dirtyChannels = new Set<string>();
  /** Son yayınlanan durum — değişmediyse tekrar yayınlanmaz. */
  private lastBroadcast = new Map<string, string>();

  private flushTimer?: NodeJS.Timeout;

  constructor(private readonly redis: RedisService) {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  /** ChatGateway.afterInit() tarafından çağrılır. */
  setBroadcaster(broadcaster: TypingBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  // -------------------------------------------------------------------------
  //  Genel API
  // -------------------------------------------------------------------------

  async start(channelId: string, userId: string): Promise<void> {
    const key = this.key(channelId);

    try {
      await this.redis.sadd(key, userId);
      // TTL her tuş vuruşunda tazelenir: kullanıcı yazmayı sürdürdükçe
      // gösterge canlı kalır, durunca 5 sn içinde söner.
      await this.redis.expire(key, TYPING_TTL_SECONDS);
      this.markDirty(channelId);
    } catch (error) {
      // Yazıyor göstergesi kritik değildir — hata mesajlaşmayı etkilemez.
      this.logger.debug({ err: (error as Error).message }, 'Yaziyor sinyali kaydedilemedi');
    }
  }

  async stop(channelId: string, userId: string): Promise<void> {
    try {
      await this.redis.srem(this.key(channelId), userId);
      this.markDirty(channelId);
    } catch (error) {
      this.logger.debug({ err: (error as Error).message }, 'Yaziyor sinyali silinemedi');
    }
  }

  async getTypingUsers(channelId: string): Promise<string[]> {
    try {
      return await this.redis.smembers(this.key(channelId));
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  private markDirty(channelId: string): void {
    // Üst sınır: bozuk bir istemci binlerce kanal için sinyal göndererek
    // belleği doldurmasın.
    if (this.dirtyChannels.size >= MAX_TRACKED_CHANNELS) {
      this.logger.warn('Yaziyor izleme siniri asildi — yeni kanallar atlaniyor');
      return;
    }
    this.dirtyChannels.add(channelId);
  }

  /**
   * Pencere sonunda değişen kanalları yayınlar.
   *
   * `lastBroadcast` karşılaştırması önemlidir: kullanıcı 5 saniye boyunca
   * yazmaya devam ederse SET içeriği değişmez ve aynı listeyi 5 kez
   * yayınlamanın anlamı yoktur.
   */
  private async flush(): Promise<void> {
    if (this.dirtyChannels.size === 0 || !this.broadcaster) return;

    const channels = Array.from(this.dirtyChannels);
    this.dirtyChannels.clear();

    try {
      // Tek pipeline: N kanal için N ayrı gidiş-dönüş yerine bir tane.
      const pipeline = this.redis.raw.pipeline();
      for (const channelId of channels) pipeline.smembers(this.key(channelId));
      const results = await pipeline.exec();

      results?.forEach(([error, data], index) => {
        if (error) return;

        const channelId = channels[index];
        const userIds = ((data as string[]) ?? []).sort();
        const signature = userIds.join(',');

        if (this.lastBroadcast.get(channelId) === signature) return;

        if (userIds.length === 0) {
          this.lastBroadcast.delete(channelId);
        } else {
          this.lastBroadcast.set(channelId, signature);
        }

        this.broadcaster?.(channelId, userIds);
      });
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'Yaziyor yayini basarisiz');
    }
  }

  private key(channelId: string): string {
    return `typing:${channelId}`;
  }
}
