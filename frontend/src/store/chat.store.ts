import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { MessageDto, PresenceStatus, Uuid } from '@incompany/contracts';

/**
 * iNCompany — Sohbet Durum Deposu (Zustand).
 *
 * NEDEN ZUSTAND, REDUX TOOLKIT DEĞİL?
 *   Gerçek zamanlı sohbet, saniyede yüzlerce küçük güncelleme üretir.
 *   Redux'ta her dispatch tüm abone bileşenleri uyandırır ve `useSelector`
 *   karşılaştırmalarını çalıştırır. Zustand'ın `subscribeWithSelector`
 *   yaklaşımında bir bileşen YALNIZCA izlediği dilim değiştiğinde yeniden
 *   render olur — 200 mesajlık bir listede fark ölçülebilir düzeydedir.
 *
 * NORMALİZASYON
 *   Mesajlar `Record<channelId, ChannelState>` altında tutulur ve kanal
 *   içinde `seq`'e göre SIRALI kalır. Sıralamayı render sırasında yapmak,
 *   her yeni mesajda O(n log n) maliyet demektir; ekleme sırasında ikili
 *   arama ile doğru konuma yerleştirmek O(log n)'dir.
 *
 * İYİMSER GÜNCELLEME (optimistic update)
 *   Kullanıcı Enter'a bastığı an mesaj listede belirir (`status: 'sending'`).
 *   Sunucu ack'i geldiğinde `clientMsgId` üzerinden eşleştirilip
 *   `status: 'sent'` ve gerçek `seq` ile değiştirilir. Bu eşleştirme
 *   olmadan mesaj listede iki kez görünür.
 */

export type MessageStatus = 'sending' | 'sent' | 'failed' | 'blocked';

export interface UiMessage extends MessageDto {
  status: MessageStatus;
  /** Engellendiyse hangi DLP kuralları tetiklendi. */
  blockedRules?: string[];
  failureReason?: string;
}

interface ChannelState {
  messages: UiMessage[];
  /** Sunucudan bilinen en yüksek seq — boşluk tespitinin referansı. */
  lastKnownSeq: number;
  lastReadSeq: number;
  unread: number;
  typingUserIds: Uuid[];
  /** Geçmişe kaydırmada daha eski mesaj var mı? */
  hasMoreHistory: boolean;
  isLoadingHistory: boolean;
  /** Yeniden bağlanma sonrası boşluk doldurma sürüyor mu? */
  isSyncing: boolean;
}

interface ChatState {
  channels: Record<Uuid, ChannelState>;
  presence: Record<Uuid, { status: PresenceStatus; customText?: string }>;
  activeChannelId: Uuid | null;
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

  // --- Eylemler ---
  setConnectionState: (state: ChatState['connectionState']) => void;
  setActiveChannel: (channelId: Uuid | null) => void;

  addOptimisticMessage: (channelId: Uuid, message: UiMessage) => void;
  confirmMessage: (channelId: Uuid, clientMsgId: Uuid, confirmed: Partial<MessageDto>) => void;
  failMessage: (channelId: Uuid, clientMsgId: Uuid, reason: string, blockedRules?: string[]) => void;

  receiveMessage: (message: MessageDto) => { gapDetected: boolean; expectedSeq: number };
  mergeMessages: (channelId: Uuid, messages: MessageDto[], position: 'prepend' | 'append') => void;
  updateMessage: (channelId: Uuid, seq: number, patch: Partial<UiMessage>) => void;
  removeMessage: (channelId: Uuid, seq: number, deletedAt: string) => void;

  setTyping: (channelId: Uuid, userIds: Uuid[]) => void;
  setPresence: (userId: Uuid, status: PresenceStatus, customText?: string) => void;

  markRead: (channelId: Uuid, upToSeq: number) => void;
  setBadge: (channelId: Uuid, lastSeq: number) => void;
  setHistoryLoading: (channelId: Uuid, loading: boolean, hasMore?: boolean) => void;
  setSyncing: (channelId: Uuid, syncing: boolean) => void;

  reset: () => void;
}

const emptyChannel = (): ChannelState => ({
  messages: [],
  lastKnownSeq: 0,
  lastReadSeq: 0,
  unread: 0,
  typingUserIds: [],
  hasMoreHistory: true,
  isLoadingHistory: false,
  isSyncing: false,
});

/**
 * İkili arama ile ekleme konumu.
 * Mesajlar her zaman seq'e göre sıralı olduğundan, doğrusal tarama yerine
 * ikili arama kullanılır — 5.000 mesajlık bir kanalda fark belirgindir.
 */
function findInsertIndex(messages: readonly UiMessage[], seq: number): number {
  let low = 0;
  let high = messages.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    const candidate = messages[mid];
    // `mid` her zaman [low, high) aralığındadır, dolayısıyla bu asla
    // undefined olmaz — ama `noUncheckedIndexedAccess` bunu kanıtlamamızı
    // ister ve kanıtlayamadığımız yerlerde haklıdır.
    if (candidate !== undefined && candidate.seq < seq) low = mid + 1;
    else high = mid;
  }
  return low;
}

export const useChatStore = create<ChatState>()(
  subscribeWithSelector(
    immer((set, get) => ({
      channels: {},
      presence: {},
      activeChannelId: null,
      connectionState: 'connecting',

      setConnectionState: (state) =>
        set((draft) => {
          draft.connectionState = state;
        }),

      setActiveChannel: (channelId) =>
        set((draft) => {
          draft.activeChannelId = channelId;
          if (channelId && !draft.channels[channelId]) {
            draft.channels[channelId] = emptyChannel();
          }
        }),

      // ----------------------------------------------------------------
      //  İyimser gönderim döngüsü
      // ----------------------------------------------------------------

      addOptimisticMessage: (channelId, message) =>
        set((draft) => {
          const channel = (draft.channels[channelId] ??= emptyChannel());
          // İyimser mesajlar geçici olarak listenin SONUNA eklenir:
          // gerçek seq henüz bilinmiyor. Ack geldiğinde doğru konuma taşınır.
          channel.messages.push(message);
        }),

      confirmMessage: (channelId, clientMsgId, confirmed) =>
        set((draft) => {
          const channel = draft.channels[channelId];
          if (!channel) return;

          const index = channel.messages.findIndex((m) => m.clientMsgId === clientMsgId);
          if (index === -1) return;

          const existing = channel.messages[index];
          if (!existing) return;

          const merged: UiMessage = {
            ...existing,
            ...confirmed,
            status: 'sent',
          };

          // Geçici konumdan çıkar, gerçek seq'e göre yerleştir.
          channel.messages.splice(index, 1);
          const target = findInsertIndex(channel.messages, merged.seq);
          channel.messages.splice(target, 0, merged);

          channel.lastKnownSeq = Math.max(channel.lastKnownSeq, merged.seq);
          // Kendi mesajınız okunmuş sayılır.
          channel.lastReadSeq = Math.max(channel.lastReadSeq, merged.seq);
        }),

      failMessage: (channelId, clientMsgId, reason, blockedRules) =>
        set((draft) => {
          const message = draft.channels[channelId]?.messages.find(
            (m) => m.clientMsgId === clientMsgId,
          );
          if (!message) return;

          message.status = blockedRules ? 'blocked' : 'failed';
          message.failureReason = reason;
          message.blockedRules = blockedRules;
        }),

      // ----------------------------------------------------------------
      //  Gelen mesajlar
      // ----------------------------------------------------------------

      /**
       * Yayından gelen mesajı ekler ve BOŞLUK TESPİTİ yapar.
       *
       * seq beklenenden büyükse arada kaçırılmış mesaj vardır (kısa ağ
       * kesintisi). Çağıran taraf `channel:sync` tetiklemelidir. Bu kontrol
       * olmadan sohbet sessizce eksik kalır — kullanıcı fark etmez, en kötü
       * hata türü budur.
       */
      receiveMessage: (message) => {
        const channelId = message.channelId;
        const before = get().channels[channelId];
        const expectedSeq = (before?.lastKnownSeq ?? 0) + 1;
        const gapDetected = Boolean(before) && message.seq > expectedSeq;

        set((draft) => {
          const channel = (draft.channels[channelId] ??= emptyChannel());

          // Yeniden yayın veya çift teslimat — Socket.IO en-az-bir-kez garantisi
          // verir, tam-bir-kez değil. Aynı seq iki kez gelebilir.
          if (channel.messages.some((m) => m.seq === message.seq)) return;

          // Kendi gönderdiğimiz mesajın yayını: iyimser kopyayı değiştir,
          // ikinci bir kopya oluşturma.
          const optimisticIndex = channel.messages.findIndex(
            (m) => m.clientMsgId === message.clientMsgId && m.status === 'sending',
          );
          if (optimisticIndex !== -1) {
            channel.messages.splice(optimisticIndex, 1);
          }

          const index = findInsertIndex(channel.messages, message.seq);
          channel.messages.splice(index, 0, { ...message, status: 'sent' });

          channel.lastKnownSeq = Math.max(channel.lastKnownSeq, message.seq);

          // Kanal açık değilse okunmamış sayacını artır.
          if (draft.activeChannelId !== channelId) {
            channel.unread = Math.max(channel.lastKnownSeq - channel.lastReadSeq, 0);
          }
        });

        return { gapDetected, expectedSeq };
      },

      /**
       * Toplu birleştirme — geçmişe kaydırma ve senkronizasyon sonucu.
       * Tekrarları eleyip tek seferde sıralar: 200 mesajı tek tek eklemek
       * 200 ayrı render tetikler.
       */
      mergeMessages: (channelId, messages, position) =>
        set((draft) => {
          const channel = (draft.channels[channelId] ??= emptyChannel());
          if (messages.length === 0) return;

          const existingSeqs = new Set(channel.messages.map((m) => m.seq));
          const incoming: UiMessage[] = messages
            .filter((m) => !existingSeqs.has(m.seq))
            .map((m) => ({ ...m, status: 'sent' as const }));

          if (incoming.length === 0) return;

          if (position === 'prepend') {
            channel.messages = [...incoming, ...channel.messages];
          } else {
            channel.messages = [...channel.messages, ...incoming];
          }

          // Tek seferde sırala — birleştirme sonrası sıra bozulmuş olabilir.
          channel.messages.sort((a, b) => a.seq - b.seq);
          channel.lastKnownSeq = Math.max(
            channel.lastKnownSeq,
            channel.messages[channel.messages.length - 1]?.seq ?? 0,
          );
        }),

      updateMessage: (channelId, seq, patch) =>
        set((draft) => {
          const message = draft.channels[channelId]?.messages.find((m) => m.seq === seq);
          if (message) Object.assign(message, patch);
        }),

      removeMessage: (channelId, seq, deletedAt) =>
        set((draft) => {
          const message = draft.channels[channelId]?.messages.find((m) => m.seq === seq);
          if (!message) return;
          // Satır listeden ÇIKARILMAZ: seq bütünlüğü korunur ve arayüz
          // "bu mesaj silindi" yer tutucusu gösterir.
          message.body = '';
          message.deletedAt = deletedAt;
        }),

      // ----------------------------------------------------------------
      //  Geçici durumlar
      // ----------------------------------------------------------------

      setTyping: (channelId, userIds) =>
        set((draft) => {
          const channel = (draft.channels[channelId] ??= emptyChannel());
          channel.typingUserIds = userIds;
        }),

      setPresence: (userId, status, customText) =>
        set((draft) => {
          draft.presence[userId] = { status, customText };
        }),

      markRead: (channelId, upToSeq) =>
        set((draft) => {
          const channel = draft.channels[channelId];
          if (!channel) return;
          // İmleç yalnızca ileri gider — sırasız gelen olaylar sayacı
          // geri sıçratmamalıdır.
          channel.lastReadSeq = Math.max(channel.lastReadSeq, upToSeq);
          channel.unread = Math.max(channel.lastKnownSeq - channel.lastReadSeq, 0);
        }),

      setBadge: (channelId, lastSeq) =>
        set((draft) => {
          const channel = (draft.channels[channelId] ??= emptyChannel());
          channel.lastKnownSeq = Math.max(channel.lastKnownSeq, lastSeq);
          channel.unread = Math.max(channel.lastKnownSeq - channel.lastReadSeq, 0);
        }),

      setHistoryLoading: (channelId, loading, hasMore) =>
        set((draft) => {
          const channel = (draft.channels[channelId] ??= emptyChannel());
          channel.isLoadingHistory = loading;
          if (hasMore !== undefined) channel.hasMoreHistory = hasMore;
        }),

      setSyncing: (channelId, syncing) =>
        set((draft) => {
          const channel = (draft.channels[channelId] ??= emptyChannel());
          channel.isSyncing = syncing;
        }),

      reset: () => set({ channels: {}, presence: {}, activeChannelId: null }),
    })),
  ),
);

// ---------------------------------------------------------------------------
//  Seçiciler (selectors)
//
//  Bileşenlerde `useChatStore((s) => s.channels[id].messages)` yazmak,
//  `channels` nesnesinin her değişiminde yeni referans üretir ve gereksiz
//  render'a yol açar. Kararlı seçiciler bunu engeller.
// ---------------------------------------------------------------------------

const EMPTY_MESSAGES: readonly UiMessage[] = Object.freeze([]);
const EMPTY_TYPING: readonly Uuid[] = Object.freeze([]);

export const selectMessages = (channelId: Uuid | null) => (state: ChatState) =>
  channelId ? (state.channels[channelId]?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;

export const selectTyping = (channelId: Uuid | null) => (state: ChatState) =>
  channelId ? (state.channels[channelId]?.typingUserIds ?? EMPTY_TYPING) : EMPTY_TYPING;

export const selectUnread = (channelId: Uuid) => (state: ChatState) =>
  state.channels[channelId]?.unread ?? 0;

/**
 * Kanal meta verisi.
 *
 * ⚠ `useShallow` İLE KULLANILMASI ZORUNLUDUR:
 *
 *     const meta = useChatStore(useShallow(selectChannelMeta(channelId)));
 *
 * Bu seçici her çağrıda YENİ bir nesne üretir. Zustand, anlık görüntüleri
 * `Object.is` ile karşılaştırır; yeni referans her zaman "değişti" sayılır,
 * bileşen yeniden render olur, seçici tekrar çalışır ve yine yeni bir nesne
 * üretir → sonsuz döngü ("Maximum update depth exceeded").
 *
 * `useShallow` önceki sonucu bir ref'te tutar ve alanlar sığ eşitse ESKİ
 * referansı döndürür; böylece anlık görüntü kararlı hale gelir.
 *
 * Neden tek tek primitif seçiciler değil? Beş ayrı abonelik, beş ayrı
 * karşılaştırma demektir. Tek sığ karşılaştırma hem daha ucuz hem de
 * alanların birlikte güncellenmesini garanti eder.
 */
export const selectChannelMeta = (channelId: Uuid | null) => (state: ChatState) => {
  if (!channelId) return null;
  const channel = state.channels[channelId];
  if (!channel) return null;
  return {
    lastKnownSeq: channel.lastKnownSeq,
    lastReadSeq: channel.lastReadSeq,
    hasMoreHistory: channel.hasMoreHistory,
    isLoadingHistory: channel.isLoadingHistory,
    isSyncing: channel.isSyncing,
  };
};

/** Toplam okunmamış — kenar çubuğu ve sekme başlığı rozeti. */
export const selectTotalUnread = (state: ChatState) =>
  Object.values(state.channels).reduce((total, channel) => total + channel.unread, 0);
