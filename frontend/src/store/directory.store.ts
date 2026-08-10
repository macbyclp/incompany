import { create } from 'zustand';
import type { Uuid } from '@incompany/contracts';

/**
 * Kullanıcı Dizini.
 *
 * Mesajlar yalnızca `senderId` taşır — her mesaja gönderen adını ve avatar
 * URL'sini gömmek, 1.000 mesajlık bir kanalda aynı bilgiyi 1.000 kez
 * göndermek demektir. Bunun yerine kimlikler ayrı bir dizinde çözülür.
 *
 * TOPLU ÇÖZÜMLEME (batch resolution)
 *   Bilinmeyen kimlikler tek tek istenmez: 50 mesajlık bir sayfa 30 farklı
 *   gönderen içerebilir ve bu 30 ayrı HTTP isteği demektir. Kimlikler kısa
 *   bir pencerede toplanır ve tek istekle çözülür.
 */

export interface DirectoryUser {
  id: Uuid;
  displayName: string;
  email: string;
  title?: string;
  avatarUrl?: string;
  departmentName?: string;
}

interface DirectoryState {
  users: Record<Uuid, DirectoryUser>;
  /** Çözümlenmeyi bekleyen kimlikler. */
  pending: Set<Uuid>;
  upsert: (users: DirectoryUser[]) => void;
  /** Bir kimliği çözüm kuyruğuna alır. Zaten biliniyorsa hiçbir şey yapmaz. */
  request: (userId: Uuid) => void;
}

const BATCH_WINDOW_MS = 50;
let batchTimer: ReturnType<typeof setTimeout> | null = null;

export const useDirectoryStore = create<DirectoryState>((set, get) => ({
  users: {},
  pending: new Set(),

  upsert: (users) =>
    set((state) => {
      const next = { ...state.users };
      for (const user of users) next[user.id] = user;
      return { users: next };
    }),

  request: (userId) => {
    const state = get();
    if (state.users[userId] || state.pending.has(userId)) return;

    state.pending.add(userId);

    // Toplama penceresi: aynı karede istenen tüm kimlikler tek istekte gider.
    if (batchTimer) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      void flushBatch();
    }, BATCH_WINDOW_MS);
  },
}));

async function flushBatch(): Promise<void> {
  const state = useDirectoryStore.getState();
  const ids = Array.from(state.pending);
  if (ids.length === 0) return;

  // Kuyruğu HEMEN temizle: istek sürerken gelen yeni kimlikler bir sonraki
  // partiye girmelidir, bu partinin başarısızlığıyla birlikte kaybolmamalıdır.
  state.pending.clear();

  try {
    // Sunucu tarafı sınır: tek istekte en fazla 200 kimlik.
    for (let offset = 0; offset < ids.length; offset += 200) {
      const chunk = ids.slice(offset, offset + 200);

      const response = await fetch('/api/v1/users/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userIds: chunk }),
      });

      if (!response.ok) throw new Error(`Dizin cozumlenemedi: ${response.status}`);

      const data = (await response.json()) as { users: DirectoryUser[] };
      useDirectoryStore.getState().upsert(data.users);

      // Sunucunun döndürmediği kimlikler (silinmiş kullanıcılar) için
      // yer tutucu yaz — aksi halde her render'da tekrar tekrar istenirler.
      const returned = new Set(data.users.map((u) => u.id));
      const missing = chunk.filter((id) => !returned.has(id));

      if (missing.length > 0) {
        useDirectoryStore.getState().upsert(
          missing.map((id) => ({ id, displayName: 'Ayrilmis kullanici', email: '' })),
        );
      }
    }
  } catch (error) {
    console.warn('[directory] cozumleme basarisiz:', error);
    // Başarısız kimlikleri geri koy — bir sonraki istekte tekrar denenir.
    const current = useDirectoryStore.getState();
    for (const id of ids) {
      if (!current.users[id]) current.pending.add(id);
    }
  }
}
