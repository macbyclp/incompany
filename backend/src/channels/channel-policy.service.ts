import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, ChannelMemberRole, GlobalRole } from '@incompany/contracts';

import type { AuthenticatedUser } from '../auth/auth.types';
import { ChannelRepository, type ChannelRecord, type MembershipRecord } from './channel.repository';
import { RedisService } from '../common/redis/redis.service';

/**
 * Kanal Kapsamlı Yetkilendirme.
 *
 * NEDEN RolesGuard YETMEZ?
 *   Global roller "bu kullanıcı kanal oluşturabilir mi?" sorusunu yanıtlar.
 *   Ama "bu kullanıcı BU kanala yazabilir mi?" sorusu kaynağa bağlıdır ve
 *   dekoratörle ifade edilemez. Bu, ABAC (öznitelik tabanlı) alanıdır.
 *
 * KURAL: yetki kararı TEK BİR YERDE verilir. HTTP controller'ı ve WebSocket
 * gateway'i aynı metodu çağırır. İki ayrı kontrol yazıldığı anda biri
 * güncellenmeyi unutur ve o, güvenlik açığının ta kendisidir.
 */

export type PolicyDecision =
  | { allowed: true; membership: MembershipRecord; channel: ChannelRecord }
  | { allowed: false; code: PolicyDenyCode; message: string };

export enum PolicyDenyCode {
  CHANNEL_NOT_FOUND = 'CHANNEL_NOT_FOUND',
  NOT_A_MEMBER = 'NOT_A_MEMBER',
  CHANNEL_ARCHIVED = 'CHANNEL_ARCHIVED',
  READ_ONLY_MEMBER = 'READ_ONLY_MEMBER',
  ANNOUNCEMENT_RESTRICTED = 'ANNOUNCEMENT_RESTRICTED',
  CROSS_TENANT = 'CROSS_TENANT',
}

/** Üyelik önbelleği — sıcak yolda her mesajda DB sorgusu yapılmaz. */
const MEMBERSHIP_CACHE_TTL_SECONDS = 60;

@Injectable()
export class ChannelPolicyService {
  private readonly logger = new Logger(ChannelPolicyService.name);

  constructor(
    private readonly channels: ChannelRepository,
    private readonly redis: RedisService,
  ) {}

  /**
   * "Bu kullanıcı bu kanala mesaj gönderebilir mi?"
   *
   * Sıralama bilinçlidir: en ucuz ve en kesin kontrol önce.
   */
  async canPost(user: AuthenticatedUser, channelId: string): Promise<PolicyDecision> {
    const channel = await this.channels.findById(channelId, user.orgId);

    if (!channel) {
      return this.deny(PolicyDenyCode.CHANNEL_NOT_FOUND, 'Kanal bulunamadi');
    }

    // Kiracı sınırı — her şeyden önce. Bir org'un kullanıcısı diğerinin
    // kanalına asla dokunamaz; bunun "bulunamadı" olarak dönmesi bilinçlidir:
    // "yetkiniz yok" demek, kanalın var olduğunu doğrular.
    if (channel.orgId !== user.orgId) {
      this.logger.warn(
        { userId: user.id, userOrg: user.orgId, channelOrg: channel.orgId, channelId },
        'Kiracilar arasi erisim denemesi',
      );
      return this.deny(PolicyDenyCode.CHANNEL_NOT_FOUND, 'Kanal bulunamadi');
    }

    if (channel.archivedAt) {
      return this.deny(PolicyDenyCode.CHANNEL_ARCHIVED, 'Kanal arsivlenmis');
    }

    const membership = await this.getMembership(channelId, user.id);
    if (!membership || membership.leftAt) {
      return this.deny(PolicyDenyCode.NOT_A_MEMBER, 'Bu kanalin uyesi degilsiniz');
    }

    if (membership.role === ChannelMemberRole.READER) {
      return this.deny(PolicyDenyCode.READ_ONLY_MEMBER, 'Bu kanalda salt okuma yetkiniz var');
    }

    // Duyuru kanalı: üyelik yazma hakkı vermez.
    // Yetki ya kanal seviyesinde (OWNER/MODERATOR) ya da global izinle gelir.
    if (channel.type === ChannelType.ANNOUNCEMENT) {
      const isChannelStaff =
        membership.role === ChannelMemberRole.OWNER ||
        membership.role === ChannelMemberRole.MODERATOR;
      const hasGlobalRight =
        user.permissions.has('announcement.post') || user.roles.includes(GlobalRole.ADMIN);

      if (!isChannelStaff && !hasGlobalRight) {
        return this.deny(
          PolicyDenyCode.ANNOUNCEMENT_RESTRICTED,
          'Duyuru kanalina yalnizca yetkili kullanicilar mesaj gonderebilir',
        );
      }
    }

    return { allowed: true, membership, channel };
  }

  /** "Bu kullanıcı bu kanalı okuyabilir mi?" — arşivlenmiş kanallar okunabilir. */
  async canRead(user: AuthenticatedUser, channelId: string): Promise<PolicyDecision> {
    const channel = await this.channels.findById(channelId, user.orgId);

    if (!channel || channel.orgId !== user.orgId) {
      return this.deny(PolicyDenyCode.CHANNEL_NOT_FOUND, 'Kanal bulunamadi');
    }

    const membership = await this.getMembership(channelId, user.id);
    if (!membership) {
      return this.deny(PolicyDenyCode.NOT_A_MEMBER, 'Bu kanalin uyesi degilsiniz');
    }

    // Kanaldan ayrılmış kullanıcı, ayrıldığı ana kadar olan geçmişi görebilir.
    // Bu, çoğu kurumsal politikaya uyar; daha katı bir yorum gerekiyorsa
    // burada `leftAt` reddi eklenir ve okuma sorgusuna seq üst sınırı konur.
    return { allowed: true, membership, channel };
  }

  /**
   * "Bu kullanıcı bu mesajı silebilir mi?"
   * Kendi mesajı VEYA moderatör VEYA global silme izni.
   */
  async canDeleteMessage(
    user: AuthenticatedUser,
    channelId: string,
    messageSenderId: string | null,
  ): Promise<boolean> {
    if (messageSenderId === user.id) return true;
    if (user.permissions.has('message.delete.any')) return true;

    const membership = await this.getMembership(channelId, user.id);
    return (
      membership?.role === ChannelMemberRole.OWNER ||
      membership?.role === ChannelMemberRole.MODERATOR
    );
  }

  /**
   * Üyelik araması, önbellekli.
   *
   * ÖNBELLEK GEÇERSİZLEŞTİRME: üyelik değiştiğinde `invalidate()` ÇAĞRILMALIDIR.
   * 60 sn TTL bir güvenlik ağıdır, tek savunma değil — kanaldan çıkarılan bir
   * kullanıcının bir dakika daha yazabilmesi kabul edilemez.
   */
  private async getMembership(
    channelId: string,
    userId: string,
  ): Promise<MembershipRecord | null> {
    const cacheKey = `member:${channelId}:${userId}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) {
        // Boş dize = "üye değil" (negatif önbellek). Yetkisiz erişim
        // denemelerinin her seferinde DB'ye inmesini engeller.
        return cached === '' ? null : (JSON.parse(cached) as MembershipRecord);
      }
    } catch (error) {
      // Redis düşmüşse yetkilendirme DURMAZ, yalnızca yavaşlar.
      this.logger.warn({ err: (error as Error).message }, 'Uyelik onbellegi okunamadi');
    }

    const membership = await this.channels.findMembership(channelId, userId);

    try {
      await this.redis.setex(
        cacheKey,
        MEMBERSHIP_CACHE_TTL_SECONDS,
        membership ? JSON.stringify(membership) : '',
      );
    } catch {
      // Önbellek yazımı en iyi çabadır; hata yutulur.
    }

    return membership;
  }

  /** Üyelik değiştiğinde ÇAĞRILMASI ZORUNLUDUR (ekleme, çıkarma, rol değişimi). */
  async invalidate(channelId: string, userId: string): Promise<void> {
    await this.redis.del(`member:${channelId}:${userId}`);
  }

  private deny(code: PolicyDenyCode, message: string): PolicyDecision {
    return { allowed: false, code, message };
  }
}
