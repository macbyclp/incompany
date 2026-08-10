import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessageKind, WsErrorCode, type MessageDto } from '@incompany/contracts';
import { randomUUID } from 'node:crypto';

import type { AuthenticatedUser } from '../auth/auth.types';
import { ChannelPolicyService, PolicyDenyCode } from '../channels/channel-policy.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { DlpService, DlpAction } from '../dlp/dlp.service';
import { RedisService } from '../common/redis/redis.service';
import { MessageRepository, type MessageRow } from './message.repository';
import { AuditService } from '../audit/audit.service';
import { sanitizeRichText } from './sanitize';

/**
 * Mesaj İş Mantığı.
 *
 * Bu servis TAŞIMA KATMANINDAN BAĞIMSIZDIR: WebSocket gateway'i de HTTP
 * controller'ı da (mobil fallback, bot API) buraya çağırır. İş kuralı tek
 * yerde durur; iki yolun farklı davranması yapısal olarak imkânsızdır.
 *
 * GÖNDERİM SIRASI — her adımın yeri bilinçlidir:
 *   1. İdempotency talebi   → yeniden gönderim çift mesaj üretmesin
 *   2. Yetki kontrolü       → en ucuz reddi en önce yap
 *   3. Temizleme (sanitize) → XSS, depolamadan ÖNCE
 *   4. DLP taraması         → ŞİFRELEMEDEN ÖNCE (şifreli veri taranamaz)
 *   5. Şifreleme            → transaction DIŞINDA (kilit süresini kısa tut)
 *   6. Kalıcılık + outbox   → tek transaction, seq burada atanır
 *   7. Sonucu önbelleğe al  → yeniden gönderimde aynı yanıt döner
 */

export interface SendMessageInput {
  channelId: string;
  clientMsgId: string;
  body: string;
  replyToSeq?: number;
  attachmentIds?: string[];
  mentions?: string[];
}

export type SendMessageResult =
  | { ok: true; message: MessageDto; dlpMasked: boolean; deduplicated: boolean }
  | { ok: false; code: WsErrorCode; message: string; ruleKeys?: string[] };

const IDEMPOTENCY_TTL_SECONDS = 300;
const IDEMPOTENCY_PENDING = ' PENDING';
const MAX_BODY_LENGTH = 16_000;
const MAX_MENTIONS = 100;
const SYNC_PAGE_LIMIT = 200;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly policy: ChannelPolicyService,
    private readonly crypto: CryptoService,
    private readonly dlp: DlpService,
    private readonly redis: RedisService,
    private readonly messages: MessageRepository,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  //  Mesaj gönderimi
  // -------------------------------------------------------------------------

  async sendMessage(user: AuthenticatedUser, input: SendMessageInput): Promise<SendMessageResult> {
    const validation = this.validateInput(input);
    if (validation) return validation;

    const idempotencyKey = `idem:${input.channelId}:${user.id}:${input.clientMsgId}`;

    // --- 1. İdempotency ------------------------------------------------------
    const claim = await this.claimIdempotency(idempotencyKey);
    if (claim.kind === 'duplicate') {
      // Aynı istek daha önce başarıyla tamamlanmış: kaydedilmiş sonucu döndür.
      // Hata dönmek YANLIŞ olur — istemcinin bakış açısından işlem başarılıdır.
      return { ok: true, message: claim.result, dlpMasked: claim.dlpMasked, deduplicated: true };
    }
    if (claim.kind === 'in_flight') {
      // Aynı clientMsgId hâlâ işleniyor. İkinci bir kayıt oluşturmak yerine
      // istemciye "az sonra tekrar dene" denir; ack zaten yolda olabilir.
      return {
        ok: false,
        code: WsErrorCode.VALIDATION_FAILED,
        message: 'Ayni mesaj halen isleniyor',
      };
    }

    let claimed = true;
    try {
      // --- 2. Yetki --------------------------------------------------------
      const decision = await this.policy.canPost(user, input.channelId);
      if (!decision.allowed) {
        return { ok: false, code: this.mapDenyCode(decision.code), message: decision.message };
      }
      const { channel } = decision;

      // --- 3. Temizleme ----------------------------------------------------
      // Markdown/zengin metin depolamadan ÖNCE temizlenir. Çıktı tarafında
      // temizlemeye güvenmek, bir istemcinin (mobil, bot, dışa aktarma) bunu
      // atlamasıyla XSS'e dönüşür. Kaynakta temizle.
      const sanitized = sanitizeRichText(input.body);
      if (sanitized.trim().length === 0) {
        return { ok: false, code: WsErrorCode.VALIDATION_FAILED, message: 'Mesaj bos olamaz' };
      }

      // --- 4. DLP ----------------------------------------------------------
      const scan = await this.dlp.scan(sanitized, {
        orgId: user.orgId,
        userId: user.id,
        channelId: input.channelId,
        channelType: channel.type,
        isE2ee: channel.e2eeEnabled,
      });

      if (scan.action === DlpAction.BLOCK) {
        // Engellenen mesaj İÇİN idempotency kaydı bırakılmaz: kullanıcı
        // mesajı düzeltip aynı taslakla tekrar göndermek isteyecektir.
        await this.releaseIdempotency(idempotencyKey);
        claimed = false;

        await this.audit.record({
          orgId: user.orgId,
          actorId: user.id,
          action: 'dlp.blocked',
          resourceType: 'channel',
          resourceId: input.channelId,
          outcome: 'DENIED',
          metadata: { rules: scan.matches.map((m) => m.ruleKey) },
        });

        return {
          ok: false,
          code: WsErrorCode.DLP_BLOCKED,
          message: 'Mesaj hassas veri icerdigi icin gonderilemedi',
          ruleKeys: scan.matches.map((m) => m.ruleKey),
        };
      }

      const dlpMasked = scan.action === DlpAction.MASK;

      // --- 5. Şifreleme (transaction dışında) -------------------------------
      // messageId burada üretilir: AAD'ye girer ve şifrelemenin seq atamasını
      // beklemesini engeller. Böylece kanal satır kilidi yalnızca INSERT
      // süresince tutulur.
      const messageId = randomUUID();
      const envelope = await this.crypto.encryptMessage(input.channelId, messageId, scan.body);

      // --- 6. Kalıcılık + outbox (tek transaction) --------------------------
      const row = await this.messages.insertWithSeq({
        id: messageId,
        orgId: user.orgId,
        channelId: input.channelId,
        senderId: user.id,
        kind: input.attachmentIds?.length ? MessageKind.FILE : MessageKind.TEXT,
        clientMsgId: input.clientMsgId,
        envelope,
        replyToSeq: input.replyToSeq ?? null,
        mentions: input.mentions ?? [],
        attachmentIds: input.attachmentIds ?? [],
        dlpVerdict: scan.matches.length
          ? { action: scan.action, rules: scan.matches.map((m) => m.ruleKey) }
          : null,
      });

      const dto = this.toDto(row, scan.body, dlpMasked);

      // --- 7. Sonucu kaydet -------------------------------------------------
      await this.storeIdempotencyResult(idempotencyKey, dto, dlpMasked);

      return { ok: true, message: dto, dlpMasked, deduplicated: false };
    } catch (error) {
      // Talep serbest bırakılmazsa kullanıcı 5 dakika boyunca aynı mesajı
      // gönderemez hale gelir — geçici bir DB hatası kalıcı bir engele dönüşür.
      if (claimed) {
        await this.releaseIdempotency(idempotencyKey).catch(() => undefined);
      }

      this.logger.error(
        { userId: user.id, channelId: input.channelId, err: (error as Error).message },
        'Mesaj gonderimi basarisiz',
      );
      return { ok: false, code: WsErrorCode.INTERNAL, message: 'Mesaj gonderilemedi' };
    }
  }

  // -------------------------------------------------------------------------
  //  Okuma
  // -------------------------------------------------------------------------

  /**
   * Yeniden bağlanma sonrası boşluk doldurma.
   * `sinceSeq`'ten SONRAKİ mesajları artan sırada döner.
   */
  async syncSince(
    user: AuthenticatedUser,
    channelId: string,
    sinceSeq: number,
    limit = SYNC_PAGE_LIMIT,
  ): Promise<{ messages: MessageDto[]; hasMore: boolean }> {
    const decision = await this.policy.canRead(user, channelId);
    if (!decision.allowed) throw new ForbiddenException(decision.message);

    const pageSize = Math.min(Math.max(limit, 1), SYNC_PAGE_LIMIT);
    // Bir fazlasını iste: hasMore'u ikinci bir COUNT sorgusu olmadan belirle.
    const rows = await this.messages.findAfterSeq(channelId, sinceSeq, pageSize + 1);

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;

    return { messages: await this.decryptRows(channelId, page), hasMore };
  }

  /** Geçmişe kaydırma — azalan sırada getirilir, artan sırada döner. */
  async getHistory(
    user: AuthenticatedUser,
    channelId: string,
    beforeSeq: number | null,
    limit = 50,
  ): Promise<{ messages: MessageDto[]; hasMore: boolean }> {
    const decision = await this.policy.canRead(user, channelId);
    if (!decision.allowed) throw new ForbiddenException(decision.message);

    const pageSize = Math.min(Math.max(limit, 1), 100);
    const rows = await this.messages.findBeforeSeq(channelId, beforeSeq, pageSize + 1);

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;

    const decrypted = await this.decryptRows(channelId, page);
    return { messages: decrypted.sort((a, b) => a.seq - b.seq), hasMore };
  }

  // -------------------------------------------------------------------------
  //  Değiştirme ve silme
  // -------------------------------------------------------------------------

  /**
   * Mesajı siler (mantıksal).
   *
   * Silme yetkisi üç kaynaktan gelebilir: kendi mesajı, kanal moderatörlüğü
   * veya global `message.delete.any` izni. Karar ChannelPolicyService'te
   * verilir — burada tekrar yazılsaydı iki mantık zamanla ayrışırdı.
   */
  async deleteMessage(
    user: AuthenticatedUser,
    channelId: string,
    seq: number,
  ): Promise<{ deletedAt: Date }> {
    const rows = await this.messages.findByIds(channelId, [seq]);
    const message = rows[0];
    if (!message) throw new NotFoundException('Mesaj bulunamadi');

    const allowed = await this.policy.canDeleteMessage(user, channelId, message.senderId);
    if (!allowed) throw new ForbiddenException('Bu mesaji silme yetkiniz yok');

    const deletedAt = await this.messages.softDelete(user.orgId, channelId, seq, user.id);
    if (!deletedAt) throw new NotFoundException('Mesaj bulunamadi veya zaten silinmis');

    // Başkasının mesajını silmek moderasyon işlemidir ve iz bırakmalıdır.
    if (message.senderId !== user.id) {
      await this.audit.record({
        orgId: user.orgId,
        actorId: user.id,
        action: 'message.delete.moderation',
        resourceType: 'message',
        resourceId: message.id,
        metadata: { channelId, seq, originalSenderId: message.senderId },
      });
    }

    return { deletedAt };
  }

  /**
   * Mesaj gövdesini günceller.
   *
   * DLP ve temizleme YENİDEN ÇALIŞTIRILIR. Aksi halde kullanıcı temiz bir
   * mesaj gönderip ardından düzenleyerek hassas veri ekleyebilir — tüm DLP
   * katmanı tek bir düzenleme ile atlatılmış olur.
   */
  async editMessage(
    user: AuthenticatedUser,
    channelId: string,
    seq: number,
    newBody: string,
  ): Promise<SendMessageResult> {
    const rows = await this.messages.findByIds(channelId, [seq]);
    const message = rows[0];
    if (!message) throw new NotFoundException('Mesaj bulunamadi');

    // Düzenleme YALNIZCA kendi mesajında yapılabilir. Moderatör bile
    // başkasının sözünü değiştirememelidir — silebilir, ama değiştiremez.
    if (message.senderId !== user.id) {
      throw new ForbiddenException('Yalnizca kendi mesajlarinizi duzenleyebilirsiniz');
    }
    if (message.deletedAt) {
      throw new ForbiddenException('Silinmis mesaj duzenlenemez');
    }

    const decision = await this.policy.canPost(user, channelId);
    if (!decision.allowed) {
      return { ok: false, code: this.mapDenyCode(decision.code), message: decision.message };
    }

    const sanitized = sanitizeRichText(newBody);
    if (sanitized.trim().length === 0) {
      return { ok: false, code: WsErrorCode.VALIDATION_FAILED, message: 'Mesaj bos olamaz' };
    }

    const scan = await this.dlp.scan(sanitized, {
      orgId: user.orgId,
      userId: user.id,
      channelId,
      channelType: decision.channel.type,
      isE2ee: decision.channel.e2eeEnabled,
    });

    if (scan.action === DlpAction.BLOCK) {
      return {
        ok: false,
        code: WsErrorCode.DLP_BLOCKED,
        message: 'Duzenleme hassas veri icerdigi icin reddedildi',
        ruleKeys: scan.matches.map((m) => m.ruleKey),
      };
    }

    // AAD messageId'ye bağlıdır ve messageId değişmez — aynı bağlamla
    // yeniden şifrelenir.
    const envelope = await this.crypto.encryptMessage(channelId, message.id, scan.body);
    const editedAt = await this.messages.updateBody(user.orgId, channelId, seq, envelope);

    if (!editedAt) throw new NotFoundException('Mesaj guncellenemedi');

    return {
      ok: true,
      message: this.toDto({ ...message, editedAt }, scan.body, scan.action === DlpAction.MASK),
      dlpMasked: scan.action === DlpAction.MASK,
      deduplicated: false,
    };
  }

  /**
   * Okundu imlecini ilerletir.
   *
   * İmleç yalnızca İLERİ gider. Geriye alma denemesi sessizce yok sayılır:
   * sırasız gelen iki `message:read` olayı, okunmamış sayacını geri sıçratmamalıdır.
   */
  async markRead(
    user: AuthenticatedUser,
    channelId: string,
    upToSeq: number,
  ): Promise<{ unread: number; changed: boolean }> {
    const decision = await this.policy.canRead(user, channelId);
    if (!decision.allowed) throw new ForbiddenException(decision.message);

    const result = await this.messages.advanceReadCursor(channelId, user.id, upToSeq);
    return { unread: Math.max(decision.channel.lastSeq - result.lastReadSeq, 0), changed: result.changed };
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  private validateInput(input: SendMessageInput): SendMessageResult | null {
    if (!input.body || typeof input.body !== 'string') {
      return { ok: false, code: WsErrorCode.VALIDATION_FAILED, message: 'Mesaj govdesi gerekli' };
    }
    if (input.body.length > MAX_BODY_LENGTH) {
      return {
        ok: false,
        code: WsErrorCode.PAYLOAD_TOO_LARGE,
        message: `Mesaj en fazla ${MAX_BODY_LENGTH} karakter olabilir`,
      };
    }
    if (input.mentions && input.mentions.length > MAX_MENTIONS) {
      // Sınırsız bahsetme, bir kanalın tamamına bildirim fırlatma yolu olur.
      return {
        ok: false,
        code: WsErrorCode.VALIDATION_FAILED,
        message: `En fazla ${MAX_MENTIONS} kisiden bahsedebilirsiniz`,
      };
    }
    return null;
  }

  /**
   * İdempotency talebi — üç durumlu.
   *
   * `SET NX` atomiktir: iki eşzamanlı yeniden gönderimden yalnızca biri talebi
   * kazanır. Kazanan işi yapar, diğeri sonucu bekler veya döner.
   */
  private async claimIdempotency(
    key: string,
  ): Promise<
    | { kind: 'claimed' }
    | { kind: 'in_flight' }
    | { kind: 'duplicate'; result: MessageDto; dlpMasked: boolean }
  > {
    try {
      const acquired = await this.redis.setIfAbsent(key, IDEMPOTENCY_PENDING, IDEMPOTENCY_TTL_SECONDS);
      if (acquired === 'OK') return { kind: 'claimed' };

      const existing = await this.redis.get(key);
      if (existing === null) {
        // TTL, GET ile SET arasında doldu. Yeniden dene; olmazsa devam et.
        const retry = await this.redis.setIfAbsent(key, IDEMPOTENCY_PENDING, IDEMPOTENCY_TTL_SECONDS);
        return retry === 'OK' ? { kind: 'claimed' } : { kind: 'in_flight' };
      }
      if (existing === IDEMPOTENCY_PENDING) return { kind: 'in_flight' };

      const parsed = JSON.parse(existing) as { message: MessageDto; dlpMasked: boolean };
      return { kind: 'duplicate', result: parsed.message, dlpMasked: parsed.dlpMasked };
    } catch (error) {
      // Redis düşmüşse mesajlaşma DURMAMALIDIR. Çift mesaj riski, hizmet
      // kesintisinden daha kabul edilebilir bir bozulmadır (graceful degradation).
      this.logger.warn(
        { err: (error as Error).message },
        'Idempotency kontrolu atlandi — Redis erisilemez',
      );
      return { kind: 'claimed' };
    }
  }

  private async storeIdempotencyResult(
    key: string,
    message: MessageDto,
    dlpMasked: boolean,
  ): Promise<void> {
    try {
      await this.redis.setex(key, IDEMPOTENCY_TTL_SECONDS, JSON.stringify({ message, dlpMasked }));
    } catch {
      // Sonuç yazılamadıysa en kötü ihtimalle yeniden gönderim çift kayıt üretir.
      // Mesaj zaten kalıcı; hata yutulur.
    }
  }

  private async releaseIdempotency(key: string): Promise<void> {
    await this.redis.del(key);
  }

  private async decryptRows(channelId: string, rows: readonly MessageRow[]): Promise<MessageDto[]> {
    const plaintexts = await this.crypto.decryptBatch(
      channelId,
      rows.map((r) => ({ messageId: r.id, envelope: r.envelope })),
    );

    return rows.map((row) =>
      this.toDto(row, plaintexts.get(row.id) ?? '[Bu mesaj cozulemedi]', Boolean(row.dlpVerdict)),
    );
  }

  private toDto(row: MessageRow, body: string, dlpMasked: boolean): MessageDto {
    return {
      id: row.id,
      channelId: row.channelId,
      seq: row.seq,
      senderId: row.senderId,
      kind: row.kind,
      // Silinmiş mesajın gövdesi ASLA gönderilmez. Satır yalnızca sıra
      // bütünlüğü için durur; içeriği istemciye taşımak silmeyi anlamsız kılar.
      body: row.deletedAt ? '' : body,
      clientMsgId: row.clientMsgId,
      replyToSeq: row.replyToSeq ?? undefined,
      threadRootSeq: row.threadRootSeq ?? undefined,
      mentions: row.mentions,
      attachments: row.attachments,
      dlpMasked: dlpMasked || undefined,
      editedAt: row.editedAt?.toISOString(),
      deletedAt: row.deletedAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private mapDenyCode(code: PolicyDenyCode): WsErrorCode {
    switch (code) {
      case PolicyDenyCode.NOT_A_MEMBER:
        return WsErrorCode.NOT_A_MEMBER;
      case PolicyDenyCode.CHANNEL_ARCHIVED:
        return WsErrorCode.CHANNEL_ARCHIVED;
      case PolicyDenyCode.CHANNEL_NOT_FOUND:
        return WsErrorCode.NOT_A_MEMBER;
      default:
        return WsErrorCode.FORBIDDEN;
    }
  }
}
