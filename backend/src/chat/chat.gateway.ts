import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { Namespace, Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import {
  WsErrorCode,
  PresenceStatus,
  type Ack,
  type EmptyPayload,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SocketAuthContext,
} from '@incompany/contracts';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthService } from '../auth/auth.service';
import { ChatService } from './chat.service';
import { PresenceService } from '../presence/presence.service';
import { TypingService } from '../presence/typing.service';
import { ChannelPolicyService } from '../channels/channel-policy.service';
import { ChannelRepository } from '../channels/channel.repository';
import { RateLimiterService } from '../common/rate-limit/rate-limiter.service';
import { WsExceptionFilter } from '../common/filters/ws-exception.filter';
import { SendMessageDto, ReadReceiptDto, SubscribeDto, SyncDto, EditMessageDto, DeleteMessageDto } from './dto';
import { sanitizePlainText } from './sanitize';
import type { AuthenticatedUser } from '../auth/auth.types';

/**
 * iNCompany Gerçek Zamanlı Gateway.
 *
 * KİMLİK DOĞRULAMA MODELİ
 *   Doğrulama HANDSHAKE'te bir kez yapılır, her mesajda değil. Nedeni:
 *   WebSocket bağlantısı uzun ömürlüdür ve her `message:send` için JWT
 *   doğrulaması yapmak, saniyede binlerce gereksiz kripto işlemi demektir.
 *   Bunun karşılığında bağlantı ömrü boyunca yetki değişimini yakalamak
 *   gerekir → `session:revoked` yayını + token süre dolumu denetimi.
 *
 * ODA STRATEJİSİ
 *   `u:{userId}`    — bağlantıda katılınır. Çok cihazlı yayın.
 *   `c:{channelId}` — TEMBEL: kullanıcı kanalı açtığında katılır.
 *   Tembel katılım kritiktir: 200 kanallı bir kullanıcı bağlantıda 200 odaya
 *   girerse, 10.000 kullanıcıda 2M oda üyeliği oluşur. Gerçekte aynı anda
 *   1-3 kanal görüntülenir; arka plan kanalları yalnızca rozet güncellemesi alır.
 *
 * HATA DURUŞU
 *   Hatalar ack üzerinden döner, socket KAPATILMAZ. Socket kapatmak istemciyi
 *   yeniden bağlanma döngüsüne sokar ve yükü artırır — hata durumunda tam
 *   olarak istemediğiniz şey budur.
 */
@WebSocketGateway({
  namespace: '/ws',
  // CORS beyaz listesi — yansıtan (reflecting) origin ASLA kullanılmaz.
  cors: {
    origin: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
    credentials: true,
  },
  // İstemci 25 sn'de bir ping alır, 20 sn içinde yanıtlamazsa bağlantı düşer.
  pingInterval: 25_000,
  pingTimeout: 20_000,
  // Yavaş tüketici koruması: tampon şişerse socket kapatılır.
  maxHttpBufferSize: 1_000_000,
  transports: ['websocket'],
})
@UseFilters(WsExceptionFilter)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  // `@WebSocketGateway({ namespace: '/ws' })` kullanıldığından, Nest bu alana
  // kök `Server`'ı DEĞİL, o namespace'e ait `Namespace` nesnesini enjekte
  // eder. Tip burada gerçek çalışma zamanı şeklini yansıtır — aksi halde
  // `.sockets`/`.adapter` gibi erişimler (Server'da bir katman daha derin
  // olan) derleyicide sessizce yanlış tipte görünür.
  @WebSocketServer()
  server!: Namespace<ClientToServerEvents, ServerToClientEvents>;

  /** Kullanıcı başına eşzamanlı cihaz sınırı. */
  private static readonly MAX_SOCKETS_PER_USER = 8;
  /** Kanal başına abonelik sınırı — bir socket sınırsız odaya giremez. */
  private static readonly MAX_SUBSCRIPTIONS = 50;
  /** Token süre dolumu denetim aralığı. */
  private static readonly TOKEN_CHECK_INTERVAL_MS = 60_000;

  private tokenWatcher?: NodeJS.Timeout;

  constructor(
    private readonly jwtGuard: JwtAuthGuard,
    private readonly auth: AuthService,
    private readonly chat: ChatService,
    private readonly presence: PresenceService,
    private readonly typing: TypingService,
    private readonly policy: ChannelPolicyService,
    private readonly channels: ChannelRepository,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  afterInit(): void {
    // Yayın fonksiyonlarını kaydet.
    //
    // Neden bu desen? PresenceService ve TypingService'in socket sunucusuna
    // ihtiyacı var, gateway'in de o servislere. Doğrudan enjeksiyon dairesel
    // bağımlılık üretir. Geri çağrı (callback) kaydı bunu kırar ve servisleri
    // birim testinde socket sunucusu olmadan test edilebilir bırakır.
    this.presence.setBroadcaster((state) => {
      this.server.to(`o:${state.orgId}`).emit('presence:update', {
        userId: state.userId,
        status: state.status,
        customText: state.customText,
        customEmoji: state.customEmoji,
        lastSeenAt: state.lastSeenAt,
      });
    });

    this.typing.setBroadcaster((channelId, userIds) => {
      this.server.to(`c:${channelId}`).emit('typing:update', { channelId, userIds });
    });

    // AuthService, oturum iptalinde açık socket'leri kapatmak için bunu çağırır.
    this.auth.setSessionRevoker((userId, reason) => this.revokeUserSessions(userId, reason));

    // Süresi dolan erişim token'larıyla açık kalan bağlantıları kapat.
    // Bu olmadan, iptal edilmiş bir oturum socket açık kaldığı sürece yaşar.
    this.tokenWatcher = setInterval(() => this.evictExpiredTokens(), ChatGateway.TOKEN_CHECK_INTERVAL_MS);
    this.tokenWatcher.unref();

    this.logger.log('Gercek zamanli gateway baslatildi');
  }

  // -------------------------------------------------------------------------
  //  Bağlantı yaşam döngüsü
  // -------------------------------------------------------------------------

  async handleConnection(client: Socket): Promise<void> {
    const correlationId = randomUUID();

    try {
      // Token handshake `auth` alanından okunur — sorgu parametresinden DEĞİL.
      // Sorgu parametreleri erişim loglarına, proxy loglarına ve tarayıcı
      // geçmişine düz metin yazılır.
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) {
        return this.rejectConnection(client, WsErrorCode.UNAUTHENTICATED, 'Token gerekli', correlationId);
      }

      const user = await this.jwtGuard.verifyAccessToken(token);

      // Cihaz sınırı: en eski socket kapatılır. Sınırsız bağlantı, tek bir
      // hesapla sunucu belleğini tüketmenin en kolay yoludur.
      const existing = await this.presence.getUserSockets(user.id);
      if (existing.length >= ChatGateway.MAX_SOCKETS_PER_USER) {
        const oldest = existing[0];
        this.server.in(oldest).disconnectSockets(true);
        this.logger.warn({ userId: user.id }, 'Cihaz siniri asildi — en eski socket kapatildi');
      }

      const auth: SocketAuthContext = {
        userId: user.id,
        orgId: user.orgId,
        sessionId: user.sessionId,
        roles: user.roles,
        permissions: Array.from(user.permissions),
        tokenVersion: user.tokenVersion,
        expiresAt: user.expiresAt,
      };

      client.data.user = user;
      client.data.auth = auth;
      client.data.subscriptions = new Set<string>();
      client.data.connectedAt = Date.now();

      // Kullanıcının tüm cihazlarına yayın yapılabilmesi için kişisel oda.
      await client.join(`u:${user.id}`);
      await client.join(`o:${user.orgId}`);

      // Presence TTL tabanlıdır: `disconnect` olayına GÜVENİLMEZ.
      // Dizüstü kapağı kapandığında veya süreç SIGKILL aldığında bu olay hiç gelmez.
      await this.presence.registerSocket(user.id, client.id, user.orgId);
      this.emitPresence(user.orgId, user.id, PresenceStatus.ONLINE);

      this.logger.log({ userId: user.id, socketId: client.id }, 'Socket baglandi');
    } catch (error) {
      this.rejectConnection(
        client,
        WsErrorCode.UNAUTHENTICATED,
        'Kimlik dogrulama basarisiz',
        correlationId,
      );
      this.logger.debug({ err: (error as Error).message }, 'Socket kimlik dogrulama reddi');
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const user = client.data?.user as AuthenticatedUser | undefined;
    if (!user) return;

    try {
      // Kullanıcı yalnızca SON cihazı da kapandığında çevrimdışı olur.
      // Telefon açıkken masaüstünü kapatmak kullanıcıyı çevrimdışı yapmamalıdır.
      const remaining = await this.presence.unregisterSocket(user.id, client.id);
      if (remaining === 0) {
        this.emitPresence(user.orgId, user.id, PresenceStatus.OFFLINE);
      }

      // Bu socket'in yazıyor göstergelerini temizle — aksi halde
      // kullanıcı bağlantısı koptuktan sonra 5 sn "yazıyor" görünür.
      const subscriptions = client.data.subscriptions as Set<string> | undefined;
      if (subscriptions) {
        await Promise.all(
          Array.from(subscriptions, (channelId) => this.typing.stop(channelId, user.id)),
        );
      }
    } catch (error) {
      this.logger.error({ err: (error as Error).message }, 'Baglanti kesme temizligi basarisiz');
    }
  }

  // -------------------------------------------------------------------------
  //  Mesajlaşma
  // -------------------------------------------------------------------------

  @SubscribeMessage('message:send')
  async onMessageSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SendMessageDto,
  ): Promise<Ack<{ messageId: string; seq: number; serverTs: string; dlpMasked: boolean }>> {
    const user = client.data.user as AuthenticatedUser;
    const correlationId = randomUUID();

    // Rate limit — yetki kontrolünden ÖNCE. Kısıtlı bir istemcinin
    // veritabanına ve DLP motoruna hiç ulaşmaması gerekir.
    const allowed = await this.rateLimiter.consume(`msg:${user.id}`, { points: 20, durationSec: 10 });
    if (!allowed.ok) {
      return {
        ok: false,
        code: WsErrorCode.RATE_LIMITED,
        message: `Cok hizli mesaj gonderiyorsunuz. ${allowed.retryAfterSec} sn sonra tekrar deneyin.`,
        correlationId,
      };
    }

    const result = await this.chat.sendMessage(user, {
      channelId: dto.channelId,
      clientMsgId: dto.clientMsgId,
      body: dto.body,
      replyToSeq: dto.replyToSeq,
      attachmentIds: dto.attachmentIds,
      mentions: dto.mentions,
    });

    if (!result.ok) {
      // DLP engeli ayrı bir event ile de bildirilir: istemci bunu farklı
      // gösterir (uyarı balonu + hangi kuralın tetiklendiği).
      if (result.code === WsErrorCode.DLP_BLOCKED) {
        client.emit('message:blocked', {
          clientMsgId: dto.clientMsgId,
          channelId: dto.channelId,
          reason: result.message,
          ruleKeys: result.ruleKeys ?? [],
        });
      }
      return { ok: false, code: result.code, message: result.message, correlationId };
    }

    // Yeniden gönderim tespit edildiyse tekrar yayınlanmaz — diğer istemciler
    // mesajı zaten aldı. Yalnızca gönderene ack döner.
    if (!result.deduplicated) {
      // Kanal odasına yayın. Redis adapter bunu tüm gateway düğümlerine taşır.
      this.server.to(`c:${dto.channelId}`).emit('message:new', result.message);

      // Odada olmayan üyelere hafif rozet güncellemesi (mesaj gövdesi taşımaz).
      void this.notifyBackgroundMembers(dto.channelId, user.id, result.message.seq);
    }

    // Gönderen yazmayı bitirdi.
    void this.typing.stop(dto.channelId, user.id);

    return {
      ok: true,
      messageId: result.message.id,
      seq: result.message.seq,
      serverTs: result.message.createdAt,
      dlpMasked: result.dlpMasked,
      correlationId,
    } as Ack<{ messageId: string; seq: number; serverTs: string; dlpMasked: boolean }>;
  }

  @SubscribeMessage('message:read')
  async onMessageRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: ReadReceiptDto,
  ): Promise<Ack<{ unread: number }>> {
    const user = client.data.user as AuthenticatedUser;
    const correlationId = randomUUID();

    try {
      const result = await this.chat.markRead(user, dto.channelId, dto.upToSeq);

      // İmleç gerçekten ilerlediyse yayınla. Her `message:read` olayını
      // yayınlamak, kullanıcı sohbette gezinirken gereksiz trafik üretir.
      if (result.changed) {
        this.server.to(`c:${dto.channelId}`).emit('message:receipt', {
          channelId: dto.channelId,
          userId: user.id,
          lastReadSeq: dto.upToSeq,
        });
      }

      return { ok: true, unread: result.unread, correlationId } as Ack<{ unread: number }>;
    } catch (error) {
      return {
        ok: false,
        code: WsErrorCode.FORBIDDEN,
        message: (error as Error).message,
        correlationId,
      };
    }
  }

  /**
   * Mesaj düzenleme.
   *
   * Yetki, DLP ve şifreleme YENİDEN uygulanır — bkz. ChatService.editMessage.
   * `message:send` ile aynı kod yolunu paylaşması KRİTİKTİR: aksi halde
   * düzenleme, gönderim sırasında zorunlu kılınan DLP taramasını atlatan
   * ikinci bir yol haline gelirdi.
   */
  @SubscribeMessage('message:edit')
  async onMessageEdit(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: EditMessageDto,
  ): Promise<Ack<{ editedAt: string }>> {
    const user = client.data.user as AuthenticatedUser;
    const correlationId = randomUUID();

    const result = await this.chat.editMessage(user, dto.channelId, dto.seq, dto.body);

    // Bu `if` bloğu TypeScript'e ayrımlı birleşimi (discriminated union)
    // daraltır: `result.ok === false` dalında `result.message` bir `string`,
    // `true` dalında bir `MessageDto`'dur. Aynı alan adının iki farklı tipe
    // sahip olması SendMessageResult'ın kasıtlı tasarımıdır (bkz. chat.service.ts).
    if (!result.ok) {
      if (result.code === WsErrorCode.DLP_BLOCKED) {
        // Düzenlemede henüz sunucu tarafı bir clientMsgId yoktur — istemci
        // düzenleme isteğini `seq` ile eşleştirir, `message:blocked` bu
        // yüzden yalnızca `channelId` + `reason` taşır.
        client.emit('message:blocked', {
          clientMsgId: '',
          channelId: dto.channelId,
          reason: result.message,
          ruleKeys: result.ruleKeys ?? [],
        });
      }
      return { ok: false, code: result.code, message: result.message, correlationId };
    }

    const editedAt = result.message.editedAt ?? new Date().toISOString();

    this.server.to(`c:${dto.channelId}`).emit('message:updated', {
      channelId: dto.channelId,
      seq: dto.seq,
      body: result.message.body,
      editedAt,
    });

    return { ok: true, editedAt, correlationId } as Ack<{ editedAt: string }>;
  }

  /**
   * Mesaj silme.
   *
   * Yetki kararı `ChannelPolicyService.canDeleteMessage`'da verilir (kendi
   * mesajı / moderatör / global izin) — bkz. ChatService.deleteMessage.
   */
  @SubscribeMessage('message:delete')
  async onMessageDelete(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DeleteMessageDto,
  ): Promise<Ack<EmptyPayload>> {
    const user = client.data.user as AuthenticatedUser;
    const correlationId = randomUUID();

    try {
      const result = await this.chat.deleteMessage(user, dto.channelId, dto.seq);

      this.server.to(`c:${dto.channelId}`).emit('message:deleted', {
        channelId: dto.channelId,
        seq: dto.seq,
        deletedAt: result.deletedAt.toISOString(),
        deletedBy: user.id,
      });

      return { ok: true, correlationId } as Ack<EmptyPayload>;
    } catch (error) {
      return {
        ok: false,
        code: WsErrorCode.FORBIDDEN,
        message: (error as Error).message,
        correlationId,
      };
    }
  }

  @SubscribeMessage('channel:sync')
  async onChannelSync(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SyncDto,
  ): Promise<Ack<{ messages: unknown[]; hasMore: boolean }>> {
    const user = client.data.user as AuthenticatedUser;
    const correlationId = randomUUID();

    // Senkronizasyon pahalıdır (DB okuma + toplu çözme). Ayrı ve daha sıkı
    // bir limit uygulanır; aksi halde yeniden bağlanma fırtınası DB'yi düşürür.
    const allowed = await this.rateLimiter.consume(`sync:${user.id}`, { points: 10, durationSec: 30 });
    if (!allowed.ok) {
      return {
        ok: false,
        code: WsErrorCode.RATE_LIMITED,
        message: 'Cok fazla senkronizasyon istegi',
        correlationId,
      };
    }

    try {
      const result = await this.chat.syncSince(user, dto.channelId, dto.sinceSeq, dto.limit);
      return { ok: true, ...result, correlationId } as Ack<{ messages: unknown[]; hasMore: boolean }>;
    } catch (error) {
      return {
        ok: false,
        code: WsErrorCode.FORBIDDEN,
        message: (error as Error).message,
        correlationId,
      };
    }
  }

  // -------------------------------------------------------------------------
  //  Kanal abonelikleri (tembel oda katılımı)
  // -------------------------------------------------------------------------

  @SubscribeMessage('channel:subscribe')
  async onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SubscribeDto,
  ): Promise<Ack<{ joined: string[]; denied: string[] }>> {
    const user = client.data.user as AuthenticatedUser;
    const subscriptions = client.data.subscriptions as Set<string>;
    const correlationId = randomUUID();

    const joined: string[] = [];
    const denied: string[] = [];

    for (const channelId of dto.channelIds) {
      if (subscriptions.size >= ChatGateway.MAX_SUBSCRIPTIONS) {
        denied.push(channelId);
        continue;
      }
      if (subscriptions.has(channelId)) {
        joined.push(channelId);
        continue;
      }

      // HER abonelik yetki kontrolünden geçer. İstemcinin gönderdiği kanal
      // listesine güvenmek, tek bir emit ile herhangi bir kanalı dinlemeye
      // izin vermek demektir.
      const decision = await this.policy.canRead(user, channelId);
      if (!decision.allowed) {
        denied.push(channelId);
        this.logger.warn(
          { userId: user.id, channelId, code: decision.code },
          'Kanal abonelik reddi',
        );
        continue;
      }

      await client.join(`c:${channelId}`);
      subscriptions.add(channelId);
      joined.push(channelId);
    }

    return { ok: true, joined, denied, correlationId } as Ack<{ joined: string[]; denied: string[] }>;
  }

  @SubscribeMessage('channel:unsubscribe')
  async onUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SubscribeDto,
  ): Promise<Ack<EmptyPayload>> {
    const subscriptions = client.data.subscriptions as Set<string>;

    await Promise.all(
      dto.channelIds.map(async (channelId) => {
        await client.leave(`c:${channelId}`);
        subscriptions.delete(channelId);
      }),
    );

    return { ok: true, correlationId: randomUUID() };
  }

  // -------------------------------------------------------------------------
  //  Geçici sinyaller — asla kalıcı değil
  // -------------------------------------------------------------------------

  @SubscribeMessage('typing:start')
  async onTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: { channelId: string },
  ): Promise<void> {
    const user = client.data.user as AuthenticatedUser;

    // Abone olunmayan bir kanalda yazıyor sinyali gönderilemez.
    // Bu kontrol olmadan, üye olmadığınız bir kanala varlığınızı sızdırabilirsiniz.
    const subscriptions = client.data.subscriptions as Set<string>;
    if (!subscriptions.has(dto.channelId)) return;

    // Redis SET + 5 sn TTL. Yayın 1 sn'lik pencerelerde toplu yapılır —
    // tuş vuruşu başına DEĞİL. 50 kişilik bir kanalda tuş başına yayın
    // saniyede binlerce event demektir.
    await this.typing.start(dto.channelId, user.id);
  }

  @SubscribeMessage('typing:stop')
  async onTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: { channelId: string },
  ): Promise<void> {
    const user = client.data.user as AuthenticatedUser;
    await this.typing.stop(dto.channelId, user.id);
  }

  @SubscribeMessage('presence:set')
  async onPresenceSet(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: { status: PresenceStatus; customText?: string; customEmoji?: string; until?: string },
  ): Promise<Ack<EmptyPayload>> {
    const user = client.data.user as AuthenticatedUser;

    await this.presence.setManualStatus(user.orgId, user.id, {
      status: dto.status,
      customText: dto.customText ? sanitizePlainText(dto.customText, 120) : undefined,
      customEmoji: dto.customEmoji,
      until: dto.until ? new Date(dto.until) : undefined,
    });

    this.emitPresence(user.orgId, user.id, dto.status, dto.customText);
    return { ok: true, correlationId: randomUUID() };
  }

  /**
   * Kalp atışı — presence TTL'ini tazeler.
   *
   * Socket.IO'nun kendi ping/pong'u taşıma katmanındadır ve uygulama
   * seviyesindeki presence kaydını tazelemez. İkisi ayrı tutulur:
   * taşıma canlı ama uygulama askıda (event loop bloke) olabilir.
   */
  @SubscribeMessage('heartbeat')
  async onHeartbeat(@ConnectedSocket() client: Socket): Promise<{ serverTs: number }> {
    const user = client.data.user as AuthenticatedUser | undefined;
    if (user) await this.presence.refresh(user.id, client.id);
    return { serverTs: Date.now() };
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  /**
   * Kanalı açık olmayan üyelere hafif rozet güncellemesi gönderir.
   * Mesaj gövdesi TAŞINMAZ — arka plandaki kullanıcıya içerik göndermek
   * hem gereksiz bant genişliği hem gereksiz veri yayılımıdır.
   */
  private async notifyBackgroundMembers(
    channelId: string,
    senderId: string,
    seq: number,
  ): Promise<void> {
    try {
      // `this.server` bir `Namespace`'tir (bkz. evictExpiredTokens yorumu):
      // `.adapter` ve `.sockets` doğrudan Namespace üzerindedir, ikinci bir
      // `.sockets` katmanı YOKTUR.
      const room = this.server.adapter.rooms.get(`c:${channelId}`);
      const activeUserIds = new Set<string>();

      if (room) {
        for (const socketId of room) {
          const socket = this.server.sockets.get(socketId);
          const uid = socket?.data?.user?.id;
          if (uid) activeUserIds.add(uid);
        }
      }

      const members = await this.channels.listMemberIds(channelId);
      for (const memberId of members) {
        if (memberId === senderId || activeUserIds.has(memberId)) continue;
        this.server.to(`u:${memberId}`).emit('channel:badge', { channelId, unread: 1, lastSeq: seq });
      }
    } catch (error) {
      // Rozet bildirimi en iyi çabadır — başarısızlığı mesaj gönderimini
      // etkilemez, yalnızca loglanır.
      this.logger.warn({ err: (error as Error).message, channelId }, 'Rozet bildirimi basarisiz');
    }
  }

  /**
   * Varlık durumu yayını.
   *
   * ÖLÇEKLEME UYARISI: şu anda tüm organizasyona yayın yapılıyor. 10.000
   * kişilik bir kurumda her bağlantı/kopma 10.000 event üretir ve bu,
   * sistemin ilk tıkanacağı yerdir.
   *
   * Üretimde daraltılmalı: kullanıcıyla ORTAK KANALI OLANLAR. Bunun için
   * `presence:watchers:{userId}` şeklinde bir Redis SET tutulur ve kanal
   * üyeliği değiştiğinde güncellenir. ~1.000 kullanıcıya kadar mevcut hali
   * yeterlidir; bu eşiği geçmeden önce değiştirilmelidir.
   */
  private emitPresence(
    orgId: string,
    userId: string,
    status: PresenceStatus,
    customText?: string,
  ): void {
    this.server.to(`o:${orgId}`).emit('presence:update', {
      userId,
      status,
      customText,
      lastSeenAt: new Date().toISOString(),
    });
  }

  /**
   * Erişim token'ının süresi dolan bağlantıları kapatır.
   *
   * WebSocket bağlantısı uzun ömürlüdür; token 15 dakikada dolar. Bu denetim
   * olmadan, bir socket açık kaldığı sürece süresi dolmuş bir kimlikle
   * çalışmaya devam eder. İstemci, kapatılmadan önce yenilenmiş token ile
   * yeniden bağlanmalıdır (frontend `socket.ts` bunu 60 sn önceden yapar).
   */
  private evictExpiredTokens(): void {
    const now = Date.now();
    let evicted = 0;

    // `this.server`, `@WebSocketGateway({ namespace: '/ws' })` nedeniyle bir
    // `Namespace` nesnesidir (kök `Server` değil) — `Namespace.sockets` zaten
    // o namespace'teki socket'lerin Map'idir, ikinci bir `.sockets` YOKTUR.
    for (const socket of this.server.sockets.values()) {
      const auth = socket.data?.auth as SocketAuthContext | undefined;
      if (auth && auth.expiresAt <= now) {
        socket.emit('session:revoked', { reason: 'TOKEN_EXPIRED' });
        socket.disconnect(true);
        evicted += 1;
      }
    }

    if (evicted > 0) {
      this.logger.log({ evicted }, 'Suresi dolmus token ile acik socketler kapatildi');
    }
  }

  private rejectConnection(
    client: Socket,
    code: WsErrorCode,
    message: string,
    correlationId: string,
  ): void {
    client.emit('error', { code, message, correlationId });
    client.disconnect(true);
  }

  /**
   * Bir kullanıcının tüm oturumlarını sonlandırır.
   * AuthService tarafından çağrılır: rol değişimi, hesap askıya alma,
   * "tüm cihazlardan çıkış" veya güvenlik olayı.
   */
  async revokeUserSessions(userId: string, reason: string): Promise<void> {
    this.server.to(`u:${userId}`).emit('session:revoked', { reason });
    this.server.in(`u:${userId}`).disconnectSockets(true);
    this.logger.log({ userId, reason }, 'Kullanici oturumlari sonlandirildi');
  }
}
