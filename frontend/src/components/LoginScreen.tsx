import { useState } from 'react';

import { authStore } from '../store/auth.store';

/**
 * Giriş Ekranı.
 *
 * İKİ GİRİŞ YOLU
 *   Varsayılan sekme SSO'dur (kurumsal IdP — Azure AD/Okta/ADFS). Bu,
 *   günlük kullanımda MFA'yı ve parola politikasını IdP'ye bırakan, önerilen
 *   yoldur.
 *
 *   İkinci sekme parola ile giriştir. Bu, SSO'yu YAPILANDIRACAK ilk
 *   yöneticinin (kurulum sihirbazının oluşturduğu hesap) ve SSO henüz
 *   kurulmamış/hiç kurulmayacak dağıtımların kullandığı yoldur — bkz.
 *   backend `AuthService.loginWithPassword`. Bu ekranın kendisi parolayı
 *   SAKLAMAZ; yalnızca sunucuya iletir.
 */

interface LoginScreenProps {
  reason: string | null;
}

type Mode = 'sso' | 'password';

/** Sunucudan gelen çıkış nedenlerinin kullanıcıya gösterilecek karşılıkları. */
const REASON_MESSAGES: Record<string, { text: string; severity: 'info' | 'warning' | 'error' }> = {
  TOKEN_EXPIRED: { text: 'Oturumunuzun suresi doldu. Lutfen tekrar giris yapin.', severity: 'info' },
  TOKEN_REUSE_DETECTED: {
    text: 'Guvenlik nedeniyle oturumunuz sonlandirildi. Bu beklenmedik bir durumsa BT ekibine bildirin.',
    severity: 'error',
  },
  USER_INACTIVE: { text: 'Hesabiniz aktif degil. BT ekibiyle iletisime gecin.', severity: 'error' },
  TOKEN_STALE: { text: 'Yetkileriniz guncellendi. Lutfen tekrar giris yapin.', severity: 'info' },
  REFRESH_FAILED: { text: 'Oturum yenilenemedi. Lutfen tekrar giris yapin.', severity: 'warning' },
  user_requested: { text: 'Cikis yaptiniz.', severity: 'info' },
};

/** Son kullanılan organizasyon adresi — girişte tekrar yazmamak için. */
function readStoredOrg(): string {
  try {
    return localStorage.getItem('incompany:org') ?? '';
  } catch {
    return '';
  }
}

function storeOrg(slug: string): void {
  try {
    localStorage.setItem('incompany:org', slug);
  } catch {
    // Gizli sekmede depolama kapalı olabilir; giriş yine de çalışmalı.
  }
}

export function LoginScreen({ reason }: LoginScreenProps) {
  const [mode, setMode] = useState<Mode>('sso');
  const [orgSlug, setOrgSlug] = useState(readStoredOrg);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const message = reason ? REASON_MESSAGES[reason] : undefined;

  const handleSsoSubmit = (event: React.FormEvent): void => {
    event.preventDefault();

    const slug = orgSlug.trim().toLowerCase();
    if (!slug) return;
    storeOrg(slug);

    // Tam sayfa yönlendirme — SPA yönlendirmesi DEĞİL. OAuth akışı
    // tarayıcının kendi gezinme mekanizmasını gerektirir; `fetch` ile
    // yapılamaz (IdP çerezleri ve yönlendirmeler çalışmaz).
    const returnTo = encodeURIComponent(window.location.pathname);
    window.location.href = `/api/v1/auth/sso/login?org=${encodeURIComponent(slug)}&returnTo=${returnTo}`;
  };

  const handlePasswordSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    const slug = orgSlug.trim().toLowerCase();
    if (!slug || !email.trim() || !password) return;

    setSubmitting(true);
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ orgSlug: slug, email: email.trim().toLowerCase(), password }),
      });

      if (!response.ok) {
        // Sunucu de bilerek genel bir mesaj döner (hesap sayımını
        // önlemek için) — burada da o genelliği koruyoruz.
        throw new Error('E-posta, parola veya organizasyon adresi hatalı');
      }

      const data = (await response.json()) as { accessToken: string; expiresAt: number };
      storeOrg(slug);

      authStore.setState({ accessToken: data.accessToken, accessTokenExpiresAt: data.expiresAt });
      const hydrated = await authStore.getState().hydrateFromServer();
      if (!hydrated) throw new Error('Oturum açılamadı, lütfen tekrar deneyin');

      // Not: bundan sonra hiçbir şey yapılmaz. `hydrateFromServer` başarılı
      // olduğunda zustand deposundaki `status` alanı 'authenticated' olur;
      // App.tsx bunu dinliyor ve otomatik olarak ana uygulamaya geçer.
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-slate-100 px-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow-sm dark:bg-slate-800">
        <h1 className="mb-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
          iNCompany
        </h1>
        <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
          Kurumsal ic iletisim platformu
        </p>

        {message && (
          <div
            role="status"
            className={`mb-4 rounded-md p-3 text-sm ${
              message.severity === 'error'
                ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'
                : message.severity === 'warning'
                  ? 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                  : 'bg-slate-50 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
            }`}
          >
            {message.text}
          </div>
        )}

        {formError && (
          <div
            role="alert"
            className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
          >
            {formError}
          </div>
        )}

        {mode === 'sso' ? (
          <form onSubmit={handleSsoSubmit}>
            <label
              htmlFor="org-slug"
              className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Organizasyon
            </label>
            <input
              id="org-slug"
              type="text"
              value={orgSlug}
              onChange={(e) => setOrgSlug(e.target.value)}
              placeholder="ornek-sirket"
              autoComplete="organization"
              autoFocus
              required
              pattern="[a-z0-9][a-z0-9\-]{1,62}"
              title="Kucuk harf, rakam ve tire kullanin"
              className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm
                         focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500
                         dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />

            <button
              type="submit"
              disabled={orgSlug.trim().length === 0}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white
                         hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Kurumsal hesapla devam et
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => void handlePasswordSubmit(e)}>
            <label
              htmlFor="pw-org-slug"
              className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Organizasyon
            </label>
            <input
              id="pw-org-slug"
              type="text"
              value={orgSlug}
              onChange={(e) => setOrgSlug(e.target.value)}
              placeholder="ornek-sirket"
              autoComplete="organization"
              autoFocus
              required
              className="mb-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm
                         focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500
                         dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />

            <label
              htmlFor="pw-email"
              className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              E-posta
            </label>
            <input
              id="pw-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              className="mb-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm
                         focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500
                         dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />

            <label
              htmlFor="pw-password"
              className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Parola
            </label>
            <input
              id="pw-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm
                         focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500
                         dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />

            <button
              type="submit"
              disabled={submitting || !orgSlug.trim() || !email.trim() || !password}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white
                         hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? 'Giris yapiliyor…' : 'Giris yap'}
            </button>
          </form>
        )}

        <button
          type="button"
          onClick={() => {
            setFormError(null);
            setMode((m) => (m === 'sso' ? 'password' : 'sso'));
          }}
          className="mt-4 w-full text-center text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          {mode === 'sso' ? 'E-posta ve parola ile giriş yap' : 'Kurumsal hesapla giriş yap (SSO)'}
        </button>

        <p className="mt-4 text-center text-xs text-slate-400">
          {mode === 'sso'
            ? 'Giris, kurumunuzun kimlik saglayicisi uzerinden yapilir.'
            : 'Yerel hesabınız, yöneticiniz veya kurulum sihirbazı tarafından oluşturulmuş olmalıdır.'}
        </p>
      </div>
    </div>
  );
}
