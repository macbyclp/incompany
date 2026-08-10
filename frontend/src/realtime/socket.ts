import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import type {
  Ack,
  EmptyPayload,
  ClientToServerEvents,
  ServerToClientEvents,
  MessageDto,
  PresenceStatus,
  Uuid,
} from '@incompany/contracts';

import { useChatStore } from '../store/chat.store';
import { authStore } from '../store/auth.store';

/**
 * Okundu imleçleri AYRI ve hafif bir depoda tutulur.
 * Sohbet deposuna koymak, her okundu bilgisinde (dakikada onlarca) mesaj
 * listesinin tamamını yeniden render ettirir.
 */
interface ReadReceiptState {
  /** channelId → userId → lastReadSeq */
  receipts: Record<Uuid, Record<Uuid, number>>;
  set: (channelId: Uuid, userId: Uuid, seq: number) => void;
}

export const readReceiptStore = create<ReadReceiptState>((setState) => ({
  receipts: {},
  set: (channelId, userId, seq) =>
    setState((state) => ({
      receipts: {
        ...state.receipts,
        [channelId]: { ...state.receipts[channelId], [userId]: seq },
      },
    })),
}));

/**
 * Gerçek Zamanlı İstemci.
 *
 * SORUMLULUKLAR
 *   · Bağlantı yaşam döngüsü ve yeniden bağlanma
 *   · Token yenileme (süre dolmadan ÖNCE)
 *   · Boşluk tespiti ve senkronizasyon
 *   · Sunucu event'lerini depoya (store) bağlama
 *
 * BİLEŞENLER BU SINIFI DOĞRUDAN KULLANMAZ. Bileşenler depodan okur, eylemleri
 * `realtimeClient` üzerinden çağırır. Bu ayrım olmadan socket referansı
 * bileşen ağacına sızar ve test edilemez hale gelir.
 */

type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Ack beklerken kullanılan zaman aşımı. */
const ACK_TIMEOUT_MS = 10_000;
/** Kalp atışı — sunucudaki 45 sn presence TTL'inin yarısından kısa. */
const HEARTBEAT_INTERVAL_MS = 25_000;
/** Token süresi dolmadan bu kadar önce yenile. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

class RealtimeClient {
  private socket: ChatSocket | null = null;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  /** Etkin abonelikler — yeniden bağlanınca geri yüklenir. */
  private subscriptions = new Set<Uuid>();
  /** Aynı kanal için eşzamanlı senkronizasyonu engeller. */
  private syncInFlight = new Set<Uuid>();

  // -------------------------------------------------------------------------
  //  Bağlantı yaşam döngüsü
  // -------------------------------------------------------------------------

  connect(accessToken: string): void {
    if (this.socket?.connected) return;

    this.socket = io(`${import.meta.env.VITE_WS_URL}/ws`, {
      // Token handshake `auth` alanında taşınır — sorgu parametresinde DEĞİL.
      // Sorgu parametreleri sunucu erişim loglarına düz metin yazılır.
      auth: { token: accessToken },
      transports: ['websocket'],
      // Üstel geri çekilme + jitter. Jitter olmadan, bir gateway düştüğünde
      // tüm istemciler AYNI ANDA yeniden bağlanır ve gelen düğümü de düşürür
      // (thundering herd).
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
      timeout: 20_000,
    });

    this.bindLifecycle();
    this.bindServerEvents();
    this.scheduleTokenRefresh();
  }

  disconnect(): void {
    this.stopTimers();
    this.subscriptions.clear();
    this.syncInFlight.clear();
    this.socket?.disconnect();
    this.socket = null;
    useChatStore.getState().setConnectionState('disconnected');
  }

  private bindLifecycle(): void {
    const socket = this.socket;
    if (!socket) return;
    const store = useChatStore.getState();

    socket.on('connect', () => {
      store.setConnectionState('connected');
      this.startHeartbeat();

      // Yeniden bağlanma sonrası: abonelikleri geri yükle ve HER kanal için
      // boşluk doldur. Bu adım atlanırsa kesinti sırasındaki mesajlar
      // sessizce kaybolur — kullanıcı fark etmez, en tehlikeli hata budur.
      if (this.subscriptions.size > 0) {
        const channelIds = Array.from(this.subscriptions);
        socket.emit('channel:subscribe', { channelIds }, (res) => {
          if (res.ok) {
            for (const channelId of res.joined) void this.syncChannel(channelId);
            // Reddedilenler artık erişilemiyor (kanaldan çıkarılmış olabilir).
            for (const channelId of res.denied) this.subscriptions.delete(channelId);
          }
        });
      }
    });

    socket.on('disconnect', (reason) => {
      this.stopHeartbeat();
      // 'io server disconnect' = sunucu bilinçli kapattı (oturum iptali).
      // Bu durumda otomatik yeniden bağlanma YAPILMAZ.
      store.setConnectionState(reason === 'io server disconnect' ? 'disconnected' : 'reconnecting');
    });

    socket.io.on('reconnect_attempt', () => {
      store.setConnectionState('reconnecting');
      // Her denemede TAZE token gönder. Eski token ile denemek, uzun
      // kesintilerde sonsuz başarısız yeniden bağlanma döngüsü yaratır.
      if (this.socket) this.socket.auth = { token: authStore.getState().accessToken };
    });

    socket.on('connect_error', (error) => {
      console.warn('[realtime] baglanti hatasi:', error.message);
    });
  }

  private bindServerEvents(): void {
    const socket = this.socket;
    if (!socket) return;
    const store = useChatStore.getState();

    socket.on('message:new', (message: MessageDto) => {
      const { gapDetected } = store.receiveMessage(message);
      // Boşluk tespit edildi: kaçırılan aralığı iste.
      if (gapDetected) void this.syncChannel(message.channelId);
    });

    socket.on('message:updated', ({ channelId, seq, body, editedAt }) => {
      store.updateMessage(channelId, seq, { body, editedAt });
    });

    socket.on('message:deleted', ({ channelId, seq, deletedAt }) => {
      store.removeMessage(channelId, seq, deletedAt);
    });

    socket.on('message:blocked', ({ clientMsgId, channelId, reason, ruleKeys }) => {
      store.failMessage(channelId, clientMsgId, reason, ruleKeys);
    });

    socket.on('message:receipt', ({ channelId, userId, lastReadSeq }) => {
      // Okundu bilgisi ayrı bir depoda tutulur (kullanıcı × kanal imleçleri).
      // `.getState()` gerekli: `readReceiptStore` bir hook'tur, `set` ise
      // durumun içindeki bir eylemdir — deponun kendisinde değil.
      readReceiptStore.getState().set(channelId, userId, lastReadSeq);
    });

    socket.on('channel:badge', ({ channelId, lastSeq }) => {
      store.setBadge(channelId, lastSeq);
    });

    socket.on('typing:update', ({ channelId, userIds }) => {
      const self = authStore.getState().userId;
      store.setTyping(channelId, userIds.filter((id) => id !== self));
    });

    socket.on('presence:update', ({ userId, status, customText }) => {
      store.setPresence(userId, status, customText);
    });

    // Sunucu oturumu sonlandırdı: rol değişimi, hesap askıya alma veya
    // "tüm cihazlardan çıkış". Token'lar atılır ve giriş ekranına dönülür.
    socket.on('session:revoked', ({ reason }) => {
      console.info('[realtime] oturum sonlandirildi:', reason);
      this.disconnect();
      authStore.getState().logout(reason);
    });

    socket.on('error', ({ code, message, correlationId }) => {
      console.error(`[realtime] ${code}: ${message} (${correlationId})`);
    });
  }

  // -------------------------------------------------------------------------
  //  Eylemler
  // -------------------------------------------------------------------------

  /**
   * Mesaj gönderir.
   *
   * `clientMsgId` ÇAĞIRAN tarafından üretilir ve yeniden denemede AYNI kalır.
   * Yeni bir UUID üretmek, sunucudaki idempotency kontrolünü işlevsiz
   * bırakır ve ağ kesintilerinde çift mesaja yol açar.
   */
  async sendMessage(
    channelId: Uuid,
    clientMsgId: Uuid,
    body: string,
    options?: { replyToSeq?: number; attachmentIds?: Uuid[]; mentions?: Uuid[] },
  ): Promise<Ack<{ messageId: Uuid; seq: number; serverTs: string; dlpMasked: boolean }>> {
    const socket = this.socket;
    if (!socket?.connected) {
      return {
        ok: false,
        code: 'INTERNAL' as never,
        message: 'Baglanti yok',
        correlationId: 'offline',
      };
    }

    return new Promise((resolve) => {
      // Zaman aşımı ZORUNLUDUR. Socket.IO ack'i varsayılan olarak sonsuza
      // kadar bekler; sunucu yanıt vermezse mesaj kalıcı olarak
      // "gönderiliyor" durumunda takılır.
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          code: 'INTERNAL' as never,
          message: 'Sunucu yanit vermedi',
          correlationId: 'timeout',
        });
      }, ACK_TIMEOUT_MS);

      socket.emit(
        'message:send',
        { channelId, clientMsgId, body, ...options },
        (response) => {
          clearTimeout(timer);
          resolve(response);
        },
      );
    });
  }

  subscribe(channelIds: Uuid[]): void {
    const socket = this.socket;
    if (!socket?.connected) {
      // Bağlantı yokken de kaydet — `connect` olayında geri yüklenir.
      for (const id of channelIds) this.subscriptions.add(id);
      return;
    }

    socket.emit('channel:subscribe', { channelIds }, (res) => {
      if (!res.ok) return;
      for (const id of res.joined) this.subscriptions.add(id);
      if (res.denied.length > 0) {
        console.warn('[realtime] abonelik reddedildi:', res.denied);
      }
    });
  }

  unsubscribe(channelIds: Uuid[]): void {
    for (const id of channelIds) this.subscriptions.delete(id);
    this.socket?.emit('channel:unsubscribe', { channelIds }, () => undefined);
  }

  markRead(channelId: Uuid, upToSeq: number): void {
    useChatStore.getState().markRead(channelId, upToSeq);
    this.socket?.emit('message:read', { channelId, upToSeq }, () => undefined);
  }

  /**
   * Mesaj düzenler.
   *
   * İYİMSER GÜNCELLEME YAPILMAZ: gövde sunucuda yeniden DLP taramasından
   * geçer ve maskelenebilir veya reddedilebilir. Erken güncelleyip sunucu
   * reddederse kullanıcı yanlış bir metin görür. Sunucudan `message:updated`
   * yayını geldiğinde depo güncellenir (bkz. bindServerEvents).
   */
  async editMessage(
    channelId: Uuid,
    seq: number,
    body: string,
  ): Promise<Ack<{ editedAt: string }>> {
    const socket = this.socket;
    if (!socket?.connected) {
      return { ok: false, code: 'INTERNAL' as never, message: 'Baglanti yok', correlationId: 'offline' };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, code: 'INTERNAL' as never, message: 'Sunucu yanit vermedi', correlationId: 'timeout' });
      }, ACK_TIMEOUT_MS);

      socket.emit('message:edit', { channelId, seq, body }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  /**
   * Mesajı siler.
   *
   * İYİMSER GÜNCELLEME YAPILMAZ.
   *
   * Bir "geri al" ilkeli olmadan iyimser silme, sunucu reddettiğinde
   * kullanıcıya kalıcı olarak yanlış bir durum gösterir: mesaj arayüzde
   * silinmiş görünür ama aslında hâlâ oradadır. `channel:sync` bunu
   * DÜZELTMEZ — o yalnızca YENİ mesajları (`seq > sinceSeq`) getirir,
   * yerel olarak silinmiş görünen eski bir mesajı geri getirmez.
   *
   * Silme nadir bir işlemdir ve ack gecikmesi (~50-200 ms) kullanıcı
   * tarafından fark edilmez; burada doğruluk, algılanan hızdan önce gelir.
   */
  async deleteMessage(channelId: Uuid, seq: number): Promise<Ack<EmptyPayload>> {
    const socket = this.socket;
    if (!socket?.connected) {
      return { ok: false, code: 'INTERNAL' as never, message: 'Baglanti yok', correlationId: 'offline' };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, code: 'INTERNAL' as never, message: 'Sunucu yanit vermedi', correlationId: 'timeout' });
      }, ACK_TIMEOUT_MS);

      socket.emit('message:delete', { channelId, seq }, (response) => {
        clearTimeout(timer);
        // Depo GÜNCELLEMESİ yalnızca başarı yayınında yapılır
        // (`message:deleted` olayı → bindServerEvents → removeMessage).
        // Burada tekrar yazmak, aynı silmeyi iki kez uygulamak olurdu.
        resolve(response);
      });
    });
  }

  /**
   * Varlık durumunu değiştirir.
   *
   * İyimser güncelleme YAPILMAZ: durum değişimi nadir bir işlemdir ve
   * sunucu yayını zaten milisaniyeler içinde geri döner. Erken güncelleyip
   * sunucu reddederse arayüz yanlış durum gösterir.
   */
  setPresence(status: PresenceStatus, customText?: string, until?: string): void {
    this.socket?.emit('presence:set', { status, customText, until }, () => undefined);
  }

  startTyping(channelId: Uuid): void {
    this.socket?.emit('typing:start', { channelId });
  }

  stopTyping(channelId: Uuid): void {
    this.socket?.emit('typing:stop', { channelId });
  }

  /**
   * Boşluk doldurma. `hasMore` dönerse özyinelemeli devam eder.
   *
   * Aynı kanal için eşzamanlı senkronizasyon engellenir: birden fazla
   * boşluk tespiti aynı anda tetiklenebilir ve sunucuya gereksiz yük biner.
   */
  private async syncChannel(channelId: Uuid): Promise<void> {
    if (this.syncInFlight.has(channelId)) return;
    this.syncInFlight.add(channelId);

    const store = useChatStore.getState();
    store.setSyncing(channelId, true);

    try {
      let sinceSeq = store.channels[channelId]?.lastKnownSeq ?? 0;
      let hasMore = true;
      let guard = 0;

      // Üst sınır: bozuk bir sunucu yanıtı sonsuz döngüye yol açmasın.
      while (hasMore && guard < 20) {
        guard += 1;

        const response = await new Promise<Ack<{ messages: MessageDto[]; hasMore: boolean }>>(
          (resolve) => {
            const timer = setTimeout(
              () =>
                resolve({
                  ok: false,
                  code: 'INTERNAL' as never,
                  message: 'sync zaman asimi',
                  correlationId: 'timeout',
                }),
              ACK_TIMEOUT_MS,
            );
            this.socket?.emit('channel:sync', { channelId, sinceSeq, limit: 200 }, (res) => {
              clearTimeout(timer);
              resolve(res);
            });
          },
        );

        if (!response.ok) {
          console.warn('[realtime] sync basarisiz:', response.message);
          break;
        }

        const last = response.messages[response.messages.length - 1];
        if (!last) break;

        useChatStore.getState().mergeMessages(channelId, response.messages, 'append');
        sinceSeq = last.seq;
        hasMore = response.hasMore;
      }
    } finally {
      this.syncInFlight.delete(channelId);
      useChatStore.getState().setSyncing(channelId, false);
    }
  }

  // -------------------------------------------------------------------------
  //  Zamanlayıcılar
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.socket?.emit('heartbeat', { ts: Date.now() }, () => undefined);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /**
   * Token'ı süresi DOLMADAN ÖNCE yeniler.
   *
   * Sunucu, süresi dolmuş token'la açık kalan socket'leri kapatır. Yenilemeyi
   * beklemek, kullanıcının 15 dakikada bir bağlantı kesintisi yaşaması demektir.
   */
  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);

    const expiresAt = authStore.getState().accessTokenExpiresAt;
    if (!expiresAt) return;

    const delay = Math.max(expiresAt - Date.now() - TOKEN_REFRESH_MARGIN_MS, 5_000);

    this.refreshTimer = setTimeout(async () => {
      try {
        const token = await authStore.getState().refreshAccessToken();
        // Yeni token'ı socket'e uygula — bir sonraki yeniden bağlanma bunu kullanır.
        if (this.socket) this.socket.auth = { token };
        this.scheduleTokenRefresh();
      } catch (error) {
        console.error('[realtime] token yenilenemedi:', error);
        authStore.getState().logout('REFRESH_FAILED');
      }
    }, delay);
  }

  private stopTimers(): void {
    this.stopHeartbeat();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }
}

export const realtimeClient = new RealtimeClient();
