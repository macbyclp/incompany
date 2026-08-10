import { useEffect, useLayoutEffect, useRef, useCallback, useMemo, useState, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/shallow';
import { ChannelType, type Uuid } from '@incompany/contracts';

import {
  useChatStore, selectMessages, selectTyping, selectChannelMeta, type UiMessage,
} from '../store/chat.store';
import { useChannelListStore, selectChannel, channelDisplayName } from '../store/channels.store';
import { useDirectoryStore } from '../store/directory.store';
import { useAuth } from '../store/auth.store';
import { realtimeClient } from '../realtime/socket';
import { MessageInput } from './MessageInput';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';
import { ChannelHeader } from './ChannelHeader';
import { ChannelMembersDialog } from './ChannelMembersDialog';

/**
 * Sohbet Penceresi.
 *
 * ÇÖZDÜĞÜ DÖRT ZOR PROBLEM
 *
 * 1) SANALLAŞTIRMA — 5.000 mesajı DOM'a basmak sekmeyi kilitler.
 *
 * 2) KAYDIRMA ÇAPASI — kullanıcı geçmişi okurken yeni mesaj gelirse görünüm
 *    ZIPLAMAMALIDIR. Geçmiş yüklenirken de konum korunur.
 *
 * 3) İLK YÜKLEME — kanal açıldığında geçmiş getirilmelidir. Bu olmadan
 *    kanal boş açılır ve kullanıcı yukarı kaydırana kadar hiçbir şey görmez.
 *
 * 4) OKUNDU İMLECİ — kullanıcı gerçekten en alta baktığında işaretlenir;
 *    kanal açıldığında veya sekme arka plandayken değil.
 *
 * BİLDİRİM SIRASI ÖNEMLİDİR: `loadHistory` → `loadOlderMessages` →
 * `handleScroll` → yaşam döngüsü etkisi. `const` bildirimleri geçici ölü
 * bölgededir (TDZ) ve bir `useCallback`'in BAĞIMLILIK DİZİSİ render sırasında
 * değerlendirilir. Sonradan tanımlanan bir fonksiyona bağımlılık vermek
 * "Cannot access before initialization" ile bileşeni düşürür.
 */

interface ChatWindowProps {
  channelId: Uuid;
  currentUserId: Uuid;
}

/** En alta bu mesafeden yakınsa "altta" kabul edilir (px). */
const BOTTOM_THRESHOLD_PX = 120;
/** Bu kadar üstte kalınca geçmiş yüklenmeye başlar (px). */
const HISTORY_TRIGGER_PX = 400;

export function ChatWindow({ channelId, currentUserId }: ChatWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  /** Geçmiş yüklemeden önceki kaydırma yüksekliği — konumu korumak için. */
  const scrollAnchorRef = useRef<{ height: number; top: number } | null>(null);

  const messages = useChatStore(useMemo(() => selectMessages(channelId), [channelId]));
  const typingUserIds = useChatStore(useMemo(() => selectTyping(channelId), [channelId]));
  // `useShallow` ZORUNLU: selectChannelMeta her çağrıda yeni nesne üretir ve
  // onsuz sonsuz render döngüsüne girer (bkz. chat.store.ts).
  const meta = useChatStore(useShallow(selectChannelMeta(channelId)));

  const setActiveChannel = useChatStore((s) => s.setActiveChannel);
  const setHistoryLoading = useChatStore((s) => s.setHistoryLoading);
  const mergeMessages = useChatStore((s) => s.mergeMessages);

  const channel = useChannelListStore(useMemo(() => selectChannel(channelId), [channelId]));
  const peer = useDirectoryStore((s) => (channel?.peerUserId ? s.users[channel.peerUserId] : undefined));
  // Moderasyon yetkisi: başkasının mesajını silebilme. Bu yalnızca DÜĞMEYİ
  // gösterip gizler — gerçek karar sunucudadır (bkz. MessageBubble üstteki not).
  const canModerate = useAuth((s) => s.can('message.delete.any'));
  const [membersOpen, setMembersOpen] = useState(false);

  // --- Geçmiş yükleme ------------------------------------------------------

  const loadHistory = useCallback(
    async (beforeSeq: number | null, anchorScroll: boolean) => {
      const el = scrollRef.current;
      if (anchorScroll && el) {
        scrollAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      }
      setHistoryLoading(channelId, true);

      try {
        const query = new URLSearchParams({ limit: '50' });
        if (beforeSeq !== null) query.set('before', String(beforeSeq));

        const response = await fetch(`/api/v1/channels/${channelId}/messages?${query}`, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        if (!response.ok) throw new Error(`Geçmiş yüklenemedi (${response.status})`);

        const data = (await response.json()) as { messages: UiMessage[]; hasMore: boolean };
        mergeMessages(channelId, data.messages, 'prepend');
        setHistoryLoading(channelId, false, data.hasMore);
      } catch (error) {
        console.error('[chat] geçmiş yükleme hatası:', error);
        // `hasMore`'a DOKUNULMAZ: geçici bir ağ hatası "daha fazla yok"
        // anlamına gelmemeli — kullanıcı tekrar deneyebilmeli.
        setHistoryLoading(channelId, false);
      }
    },
    [channelId, mergeMessages, setHistoryLoading],
  );

  const loadOlderMessages = useCallback(() => {
    void loadHistory(messages[0]?.seq ?? null, true);
  }, [loadHistory, messages]);

  // --- Kaydırma ------------------------------------------------------------

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom < BOTTOM_THRESHOLD_PX;

    if (el.scrollTop < HISTORY_TRIGGER_PX && meta?.hasMoreHistory && !meta.isLoadingHistory) {
      loadOlderMessages();
    }
  }, [meta?.hasMoreHistory, meta?.isLoadingHistory, loadOlderMessages]);

  // --- Kanal yaşam döngüsü -------------------------------------------------

  useEffect(() => {
    setActiveChannel(channelId);
    realtimeClient.subscribe([channelId]);
    // Kanal değiştiğinde önceki kanalın üye paneli açık kalmasın —
    // kullanıcı yeni kanalın üyelerini değil, eskisinin listesini görmemeli.
    setMembersOpen(false);

    // `getState()` ile okunuyor, abonelikle değil: `messages` bağımlılığı
    // eklemek bu etkiyi her yeni mesajda çalıştırır ve sonsuz istek döngüsü
    // yaratır.
    const existing = useChatStore.getState().channels[channelId]?.messages ?? [];
    if (existing.length === 0) void loadHistory(null, false);

    return () => {
      // Aboneliği bırakmak KRİTİKTİR: bırakılmazsa kullanıcı gezindikçe
      // socket onlarca odada birikir.
      realtimeClient.unsubscribe([channelId]);
    };
  }, [channelId, setActiveChannel, loadHistory]);

  // --- Sanallaştırma -------------------------------------------------------

  const rows = useMemo(() => buildRows(messages), [messages]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'date' ? 40 : 68),
    overscan: 10,
    // Anahtar olarak indeks DEĞİL kimlik: liste başına mesaj eklendiğinde
    // indeksler kayar ve tüm satırlar gereksizce yeniden ölçülür.
    getItemKey: (index) => rows[index]?.key ?? `row-${index}`,
  });

  // Geçmiş eklendikten sonra kaydırma konumunu koru.
  // `useLayoutEffect` ZORUNLUDUR: `useEffect` boyamadan SONRA çalışır ve
  // kullanıcı bir kare boyunca sıçramayı görür.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = scrollAnchorRef.current;
    if (!el || !anchor) return;

    const delta = el.scrollHeight - anchor.height;
    if (delta > 0) el.scrollTop = anchor.top + delta;
    scrollAnchorRef.current = null;
  }, [rows.length]);

  // Yeni mesajda otomatik kaydır — YALNIZCA kullanıcı zaten alttaysa.
  useEffect(() => {
    if (!isAtBottomRef.current || rows.length === 0) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [rows.length, virtualizer]);

  // --- Okundu işaretleme ---------------------------------------------------

  useEffect(() => {
    if (!isAtBottomRef.current) return;
    if (document.visibilityState !== 'visible') return;

    const last = messages[messages.length - 1];
    if (!last || !meta) return;
    if (last.seq > meta.lastReadSeq) realtimeClient.markRead(channelId, last.seq);
  }, [channelId, messages, meta]);

  // --- Render --------------------------------------------------------------

  const displayName = channelDisplayName(channel, peer?.displayName);
  const isEmpty = messages.length === 0 && !meta?.isLoadingHistory;

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-white dark:bg-slate-900" aria-label="Sohbet">
      <ChannelHeader
        type={channel?.type ?? ChannelType.GROUP}
        name={displayName}
        topic={channel?.type === ChannelType.DM ? peer?.title : channel?.topic}
        memberCount={channel?.memberCount}
        isE2ee={channel?.isE2ee}
        isReadOnly={channel?.isReadOnly}
        onMembersClick={
          channel?.type !== ChannelType.DM ? () => setMembersOpen(true) : undefined
        }
      />

      <ChannelMembersDialog
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        channelId={channelId}
        channelName={displayName}
      />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        // Ekran okuyucular için canlı bölge. `polite`: kullanıcının o anki
        // eylemini kesmez, ara verdiğinde okur.
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {meta?.isLoadingHistory && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-slate-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500 motion-reduce:animate-none" />
            Geçmiş yükleniyor…
          </div>
        )}

        {isEmpty ? (
          <ChannelEmptyState name={displayName} type={channel?.type} />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;

              return (
                <div
                  key={virtualRow.key}
                  // Gerçek yüksekliği ölç: mesajlar değişken boyutludur.
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {row.kind === 'date' ? (
                    <DateSeparator label={row.label} />
                  ) : (
                    <MemoizedBubble
                      message={row.message}
                      isOwn={row.message.senderId === currentUserId}
                      showAvatar={row.showAvatar}
                      canModerate={canModerate}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="h-2" />
      </div>

      <TypingIndicator userIds={typingUserIds} />
      <MessageInput channelId={channelId} channelName={displayName} />
    </section>
  );
}

// ---------------------------------------------------------------------------
//  Satır modeli
// ---------------------------------------------------------------------------

type Row =
  | { kind: 'date'; key: string; label: string }
  | { kind: 'message'; key: string; message: UiMessage; showAvatar: boolean };

/**
 * Mesaj listesini render satırlarına çevirir: tarih ayraçları ekler ve
 * ardışık mesajları gruplar.
 *
 * GRUPLAMA: aynı kişinin 5 dakika içindeki ardışık mesajlarında avatar ve
 * isim tekrarlanmaz. Küçük bir detay ama yoğun kanallarda okunabilirliği
 * belirgin biçimde artırır.
 */
function buildRows(messages: readonly UiMessage[]): Row[] {
  const rows: Row[] = [];
  let lastDateKey = '';

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    const date = new Date(message.createdAt);
    const dateKey = date.toDateString();

    if (dateKey !== lastDateKey) {
      rows.push({ kind: 'date', key: `date-${dateKey}`, label: formatDateLabel(date) });
      lastDateKey = dateKey;
    }

    const previous = messages[i - 1];
    // Tarih ayracı araya girdiyse gruplama kesilir — ayraçtan hemen sonraki
    // mesaj her zaman avatarlı başlar.
    const startsNewGroup =
      !previous ||
      rows[rows.length - 1]?.kind === 'date' ||
      previous.senderId !== message.senderId ||
      date.getTime() - new Date(previous.createdAt).getTime() > 5 * 60 * 1000;

    rows.push({ kind: 'message', key: message.id, message, showAvatar: startsNewGroup });
  }

  return rows;
}

function formatDateLabel(date: Date): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);

  if (date.toDateString() === today.toDateString()) return 'Bugün';
  if (date.toDateString() === yesterday.toDateString()) return 'Dün';

  return date.toLocaleDateString('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

// ---------------------------------------------------------------------------

/**
 * Mesaj satırı memoize edilir.
 *
 * Bu olmadan sanallaştırma penceresi her kaydırmada tüm görünür satırları
 * yeniden render eder. `message` referansı Immer sayesinde değişmediği
 * sürece sığ karşılaştırma yeterlidir.
 */
const MemoizedBubble = memo(MessageBubble, (prev, next) =>
  prev.message.id === next.message.id &&
  prev.message.body === next.message.body &&
  prev.message.status === next.message.status &&
  prev.message.editedAt === next.message.editedAt &&
  prev.message.deletedAt === next.message.deletedAt &&
  prev.showAvatar === next.showAvatar &&
  prev.canModerate === next.canModerate,
);

function DateSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-5 py-2.5">
      <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
      <span className="rounded-full border border-slate-200 px-2.5 py-0.5 text-[11px] font-medium text-slate-500 dark:border-slate-700 dark:text-slate-400">
        {label}
      </span>
      <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
    </div>
  );
}

function ChannelEmptyState({ name, type }: { name: string; type?: ChannelType }) {
  const isDm = type === ChannelType.DM;

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-xl dark:bg-slate-800">
        {isDm ? '👋' : '#'}
      </div>
      <h2 className="mb-1 text-[15px] font-semibold text-slate-900 dark:text-slate-100">
        {isDm ? `${name} ile sohbetin başlangıcı` : `#${name} kanalının başlangıcı`}
      </h2>
      <p className="max-w-xs text-sm text-slate-500 dark:text-slate-400">
        {isDm
          ? 'Henüz mesaj yok. İlk mesajı siz gönderin.'
          : 'Bu kanalda henüz mesaj yok. Konuşmayı siz başlatın.'}
      </p>
    </div>
  );
}
