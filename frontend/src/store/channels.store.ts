import { create } from 'zustand';
import { ChannelType, type Uuid } from '@incompany/contracts';

import { useDirectoryStore } from './directory.store';

/**
 * Kanal Listesi Deposu.
 *
 * NEDEN AYRI BİR DEPO?
 *   Kanal metadata'sı (ad, konu, tip, üye sayısı) önce yalnızca
 *   `ChannelSidebar` bileşeninin yerel `useState`'inde duruyordu. Sonuç:
 *   `ChatWindow` açık kanalın ADINI bile bilemiyordu ve başlık çizemiyordu.
 *
 *   Bir veri iki bileşende gerekiyorsa, ikisinin de ortak atasında ya da
 *   bir depoda durmalıdır. Prop olarak geçirmek bu durumda App'i gereksiz
 *   yere kanal listesinden haberdar ederdi.
 *
 * Mesajlardan AYRI tutulur: kanal listesi nadiren, mesajlar saniyede
 * onlarca kez değişir. Tek depoda olsalardı her yeni mesaj, kenar
 * çubuğundaki tüm satırları yeniden render ettirirdi.
 */

export interface ChannelSummary {
  id: Uuid;
  type: ChannelType;
  name: string | null;
  topic: string | null;
  unreadCount: number;
  isPinned: boolean;
  isMuted: boolean;
  memberCount?: number;
  isE2ee?: boolean;
  isReadOnly?: boolean;
  /** DM'lerde karşı tarafın kimliği — ad ve durum ondan çözülür. */
  peerUserId?: Uuid;
}

interface ChannelListState {
  byId: Record<Uuid, ChannelSummary>;
  order: Uuid[];
  isLoading: boolean;
  error: string | null;

  setChannels: (channels: ChannelSummary[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useChannelListStore = create<ChannelListState>((set) => ({
  byId: {},
  order: [],
  isLoading: true,
  error: null,

  setChannels: (channels) =>
    set({
      byId: Object.fromEntries(channels.map((c) => [c.id, c])),
      order: channels.map((c) => c.id),
      isLoading: false,
      error: null,
    }),

  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error, isLoading: false }),
}));

/**
 * Tek bir kanalın özeti.
 *
 * `byId` üzerinden okur ve kararlı bir referans döner — kanal nesnesi
 * değişmediği sürece abone bileşen yeniden render OLMAZ. `order`
 * dizisinden `find` ile aramak her çağrıda tarama yapardı.
 */
export const selectChannel = (channelId: Uuid | null) => (state: ChannelListState) =>
  channelId ? (state.byId[channelId] ?? null) : null;

/** Kanal için görüntülenecek başlık. DM'lerde ad dizinden çözülür. */
export function channelDisplayName(
  channel: ChannelSummary | null,
  peerName?: string,
): string {
  if (!channel) return '';
  if (channel.type === ChannelType.DM) return peerName ?? '…';
  return channel.name ?? 'Adsız kanal';
}

/**
 * Kanal listesini sunucudan yeniden çeker.
 *
 * TEK KAYNAKTIR — ne kanal oluşturma, ne üye ekleme/çıkarma kendi başına
 * `byId`'yi güncellemeye çalışmaz. Sebebi basit: `memberCount` gibi türetilmiş
 * bir alanı istemci tarafında elle hesaplamak, sunucudaki gerçek değerle
 * er ya da geç ayrışır (bir üye ekleme isteği başarısız olur ama iyimser
 * sayaç yine de artmış olur). Tek doğruluk kaynağı sunucu çağrısıdır; bu
 * fonksiyon her mutasyondan sonra çağrılır ve `byId`'yi tamamen tazeler.
 */
export async function refreshChannels(): Promise<void> {
  try {
    const response = await fetch('/api/v1/channels', { credentials: 'include' });
    if (!response.ok) return;

    const data = (await response.json()) as { channels: ChannelSummary[] };
    useChannelListStore.getState().setChannels(data.channels);

    // DM karşı taraflarını dizine iste. Bu satır atlanırsa yeni açılan bir
    // DM'in başlığı "…" olarak kalır — kanal listesi yalnızca `peerUserId`
    // taşır, adı taşımaz.
    for (const channel of data.channels) {
      if (channel.peerUserId) useDirectoryStore.getState().request(channel.peerUserId);
    }
  } catch {
    // Sessizce geç — kullanıcı sayfayı yenileyerek de görebilir.
  }
}
