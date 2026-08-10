import { create } from 'zustand';
import type { GlobalRole, Uuid } from '@incompany/contracts';

/**
 * Kimlik Durumu.
 *
 * ERİŞİM TOKEN'I YALNIZCA BELLEKTE TUTULUR.
 *
 *   localStorage/sessionStorage KULLANILMAZ. Gerekçe: bir XSS açığı
 *   oluştuğunda saldırganın çalıştırdığı ilk satır `localStorage.getItem`
 *   olur. Bellekteki bir değişkeni çalmak da mümkündür ama saldırganın
 *   sayfada AKTİF OLDUĞU ana bağlıdır — kalıcı depolama ise sayfa her
 *   açıldığında hazır bir hedeftir.
 *
 *   Refresh token httpOnly çerezdedir ve JavaScript'ten hiç görünmez.
 *   Sayfa yenilendiğinde erişim token'ı kaybolur ama çerez durduğu için
 *   `/auth/refresh` çağrısı sessizce yeni bir token alır. Kullanıcı
 *   deneyiminde kayıp yoktur, saldırı yüzeyinde belirgin kazanç vardır.
 *
 * `zustand` deposu doğrudan (hook olmadan) da kullanılır: `realtimeClient`
 * bir React bileşeni değildir ve `authStore.getState()` ile erişir.
 */

interface AuthState {
  userId: Uuid;
  orgId: Uuid;
  email: string;
  displayName: string;
  roles: GlobalRole[];
  permissions: Set<string>;

  /** SADECE BELLEKTE. Kalıcı depolamaya asla yazılmaz. */
  accessToken: string;
  accessTokenExpiresAt: number;

  status: 'unauthenticated' | 'authenticating' | 'authenticated';
  logoutReason: string | null;

  setSession: (session: {
    userId: Uuid;
    orgId: Uuid;
    email: string;
    displayName: string;
    roles: GlobalRole[];
    permissions: string[];
    accessToken: string;
    expiresAt: number;
  }) => void;

  refreshAccessToken: () => Promise<string>;
  hydrateFromServer: () => Promise<boolean>;
  logout: (reason?: string) => void;
  can: (permission: string) => boolean;
}

const EMPTY_SESSION = {
  userId: '',
  orgId: '',
  email: '',
  displayName: '',
  roles: [] as GlobalRole[],
  permissions: new Set<string>(),
  accessToken: '',
  accessTokenExpiresAt: 0,
};

/** Eşzamanlı yenileme isteklerini tekilleştirir. */
let refreshInFlight: Promise<string> | null = null;

export const authStore = create<AuthState>((set, get) => ({
  ...EMPTY_SESSION,
  status: 'unauthenticated',
  logoutReason: null,

  setSession: (session) =>
    set({
      userId: session.userId,
      orgId: session.orgId,
      email: session.email,
      displayName: session.displayName,
      roles: session.roles,
      permissions: new Set(session.permissions),
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.expiresAt,
      status: 'authenticated',
      logoutReason: null,
    }),

  /**
   * Erişim token'ını yeniler.
   *
   * TEKİLLEŞTİRME KRİTİKTİR: token dolduğunda beş farklı istek aynı anda
   * 401 alıp beşi birden yenileme çağırırsa, sunucudaki refresh rotasyonu
   * bunları "yeniden kullanım" sayar ve TÜM AİLEYİ iptal eder — kullanıcı
   * sistemden atılır. Aynı anda yalnızca bir yenileme uçuşta olmalıdır.
   */
  refreshAccessToken: async () => {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      try {
        const response = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // httpOnly refresh çerezinin gönderilmesi için zorunlu.
          credentials: 'include',
          body: '{}',
        });

        if (!response.ok) {
          throw new Error(`Yenileme basarisiz: ${response.status}`);
        }

        const data = (await response.json()) as { accessToken: string; expiresAt: number };

        set({ accessToken: data.accessToken, accessTokenExpiresAt: data.expiresAt });
        return data.accessToken;
      } finally {
        // Başarı da başarısızlık da olsa kilidi bırak; aksi halde bir
        // hatadan sonra yenileme kalıcı olarak bloke olur.
        refreshInFlight = null;
      }
    })();

    return refreshInFlight;
  },

  /**
   * `/auth/me`'yi çağırıp tam profili (rol, izin, ad) depoya yazar.
   *
   * ÜÇ YERDEN çağrılır: sayfa ilk yüklendiğinde (refresh çerezi varsa),
   * SSO geri dönüşünde ve kurulum sihirbazı tamamlandığında. Mantık TEK
   * yerde durur — üçü ayrı ayrı yazılsaydı, `/auth/me` yanıtının şekli
   * değiştiğinde biri güncellenmeyi unuturdu.
   *
   * Çağıran taraf, bunu çağırmadan ÖNCE `accessToken`'ın depoda geçerli
   * bir değerle ayarlanmış olmasını sağlamalıdır (`refreshAccessToken`
   * veya bir giriş/kurulum yanıtından).
   */
  hydrateFromServer: async () => {
    try {
      const response = await fetch('/api/v1/auth/me', { credentials: 'include' });
      if (!response.ok) return false;

      const me = (await response.json()) as {
        id: string;
        orgId: string;
        email?: string;
        displayName?: string;
        roles: GlobalRole[];
        permissions: string[];
      };

      get().setSession({
        userId: me.id,
        orgId: me.orgId,
        email: me.email ?? '',
        displayName: me.displayName ?? '',
        roles: me.roles,
        permissions: me.permissions,
        accessToken: get().accessToken,
        expiresAt: get().accessTokenExpiresAt,
      });
      return true;
    } catch {
      return false;
    }
  },

  logout: (reason) => {
    // Sunucuya bildir — refresh çerezi ve oturum kaydı temizlensin.
    // Yanıt BEKLENMEZ: istemci tarafı çıkış her koşulda gerçekleşmelidir.
    void fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' }).catch(
      () => undefined,
    );

    set({ ...EMPTY_SESSION, status: 'unauthenticated', logoutReason: reason ?? null });
  },

  /**
   * İzin kontrolü.
   *
   * DİKKAT: bu YALNIZCA arayüz içindir — bir düğmeyi gizlemek gibi.
   * GÜVENLİK KONTROLÜ DEĞİLDİR. İstemci tarafı her kontrol devre dışı
   * bırakılabilir; asıl karar her zaman sunucuda verilir.
   */
  can: (permission) => get().permissions.has(permission),
}));

/** React bileşenleri için hook — seçici ile kullanılır. */
export const useAuth = authStore;
