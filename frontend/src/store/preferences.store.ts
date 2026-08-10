import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Kullanıcı Tercihleri.
 *
 * İKİ KATMANLI: yerel (anında) + sunucu (cihazlar arası).
 *   Tema değişimi ağ turunu BEKLEMEZ — kullanıcı tıklar, arayüz anında
 *   döner. Sunucuya yazma arka planda yapılır ve başarısız olursa yalnızca
 *   diğer cihazlara yayılmaz; bu cihazda tercih yine geçerlidir.
 *
 * `localStorage`'da tutulmasının sebebi, sayfa ilk açıldığında sunucu
 * yanıtını beklemeden doğru temayla boyanabilmesi. Aksi halde her yenilemede
 * açık temadan koyu temaya geçen bir "flaş" görülür.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

export interface Preferences {
  theme: ThemePreference;
  /** Mesaj listesinde daha az boşluk — çok kanallı kullanıcılar için. */
  compactMode: boolean;
  /** Enter gönderir mi, yoksa yeni satır mı ekler? */
  enterToSend: boolean;
  notifications: {
    desktop: boolean;
    sound: boolean;
    /** Yalnızca bahsedilmelerde bildirim gönder. */
    mentionsOnly: boolean;
    /** Rahatsız etmeyin saatleri (24s biçimi, "HH:MM"). */
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
  };
  /** Bağlantı önizlemelerini aç — kapalıysa dış istek yapılmaz. */
  linkPreviews: boolean;
}

const DEFAULTS: Preferences = {
  theme: 'system',
  compactMode: false,
  enterToSend: true,
  notifications: {
    desktop: true,
    sound: true,
    mentionsOnly: false,
    quietHoursEnabled: false,
    quietHoursStart: '19:00',
    quietHoursEnd: '08:00',
  },
  linkPreviews: true,
};

interface PreferencesState extends Preferences {
  isSyncing: boolean;
  set: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  setNotification: <K extends keyof Preferences['notifications']>(
    key: K,
    value: Preferences['notifications'][K],
  ) => void;
  hydrateFromServer: (prefs: Partial<Preferences>) => void;
  reset: () => void;
}

export const usePreferences = create<PreferencesState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,
      isSyncing: false,

      set: (key, value) => {
        set({ [key]: value } as Partial<PreferencesState>);
        void pushToServer({ [key]: value });
      },

      setNotification: (key, value) => {
        const next = { ...get().notifications, [key]: value };
        set({ notifications: next });
        void pushToServer({ notifications: next });
      },

      /** Sunucudan gelen tercihleri uygular — yerel yazma tetiklemez. */
      hydrateFromServer: (prefs) =>
        set({
          ...prefs,
          notifications: { ...DEFAULTS.notifications, ...prefs.notifications },
        }),

      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'incompany:preferences',
      // `isSyncing` geçici bir durumdur, kalıcı depoya YAZILMAZ.
      partialize: ({ isSyncing: _ignored, ...rest }) => rest,
    },
  ),
);

/**
 * Tercihleri sunucuya yazar — ateşle-unut.
 *
 * Hata YUTULUR: tercih senkronizasyonunun başarısızlığı kullanıcıya hata
 * göstermeyi hak etmez. Tercih bu cihazda zaten uygulanmıştır; yalnızca
 * diğer cihazlara yayılmamış olur ve bir sonraki değişiklikte düzelir.
 */
async function pushToServer(patch: Partial<Preferences>): Promise<void> {
  try {
    await fetch('/api/v1/users/me/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(patch),
    });
  } catch {
    // Sessizce geç.
  }
}

/**
 * Temayı DOM'a uygular.
 *
 * `documentElement`'e sınıf eklenir (tailwind.config.js → darkMode: 'class').
 * `system` seçiliyse işletim sistemi tercihi dinlenir ve DEĞİŞİRSE anında
 * yansıtılır — kullanıcı gün batımında otomatik koyu temaya geçen bir
 * sistemde uygulamayı yeniden başlatmak zorunda kalmamalıdır.
 *
 * @returns Dinleyiciyi kaldıran temizleme fonksiyonu.
 */
export function applyTheme(theme: ThemePreference): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const paint = (): void => {
    const isDark = theme === 'dark' || (theme === 'system' && media.matches);
    document.documentElement.classList.toggle('dark', isDark);
    // Tarayıcının kendi arayüzü (kaydırma çubuğu, form kontrolleri) de uysun.
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  };

  paint();

  if (theme !== 'system') return () => undefined;

  media.addEventListener('change', paint);
  return () => media.removeEventListener('change', paint);
}
