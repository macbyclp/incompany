import { useState } from 'react';

/**
 * Giriş Ekranı.
 *
 * BU EKRAN PAROLA ALMAZ.
 *   Kimlik doğrulama kurumsal IdP'de (Azure AD / Okta / ADFS) yapılır.
 *   Uygulama parola saklamaz, doğrulamaz ve sıfırlamaz. MFA, parola
 *   politikası, hesap kilitleme ve şüpheli giriş tespiti kurumun mevcut
 *   IdP'sinin sorumluluğundadır — bunları yeniden uygulamak hem gereksiz
 *   hem de kaçınılmaz olarak daha zayıf olur.
 *
 *   Tek girdi organizasyon tanımlayıcısıdır; gerisi IdP'de gerçekleşir.
 */

interface LoginScreenProps {
  reason: string | null;
}

/** Sunucudan gelen çıkış nedenlerinin kullanıcıya gösterilecek karşılıkları. */
const REASON_MESSAGES: Record<string, { text: string; severity: 'info' | 'warning' | 'error' }> = {
  TOKEN_EXPIRED: { text: 'Oturumunuzun suresi doldu. Lutfen tekrar giris yapin.', severity: 'info' },
  TOKEN_REUSE_DETECTED: {
    // Bu mesaj kasıtlı olarak nettir: kullanıcının bunu BT'ye bildirmesi
    // gerekir. Belirsiz bir "bir hata oluştu" mesajı, gerçek bir güvenlik
    // olayının fark edilmeden geçmesine yol açar.
    text: 'Guvenlik nedeniyle oturumunuz sonlandirildi. Bu beklenmedik bir durumsa BT ekibine bildirin.',
    severity: 'error',
  },
  USER_INACTIVE: { text: 'Hesabiniz aktif degil. BT ekibiyle iletisime gecin.', severity: 'error' },
  TOKEN_STALE: { text: 'Yetkileriniz guncellendi. Lutfen tekrar giris yapin.', severity: 'info' },
  REFRESH_FAILED: { text: 'Oturum yenilenemedi. Lutfen tekrar giris yapin.', severity: 'warning' },
  user_requested: { text: 'Cikis yaptiniz.', severity: 'info' },
};

export function LoginScreen({ reason }: LoginScreenProps) {
  // Son kullanılan organizasyon hatırlanır — her girişte yeniden yazmak
  // gereksiz bir sürtünmedir. Bu bir sır değildir, localStorage uygundur.
  const [orgSlug, setOrgSlug] = useState(() => {
    try {
      return localStorage.getItem('incompany:org') ?? '';
    } catch {
      return '';
    }
  });

  const message = reason ? REASON_MESSAGES[reason] : undefined;

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();

    const slug = orgSlug.trim().toLowerCase();
    if (!slug) return;

    try {
      localStorage.setItem('incompany:org', slug);
    } catch {
      // Gizli sekmede depolama kapalı olabilir; giriş yine de çalışmalı.
    }

    // Tam sayfa yönlendirme — SPA yönlendirmesi DEĞİL. OAuth akışı
    // tarayıcının kendi gezinme mekanizmasını gerektirir; `fetch` ile
    // yapılamaz (IdP çerezleri ve yönlendirmeler çalışmaz).
    const returnTo = encodeURIComponent(window.location.pathname);
    window.location.href = `/api/v1/auth/sso/login?org=${encodeURIComponent(slug)}&returnTo=${returnTo}`;
  };

  return (
    <div className="flex h-screen items-center justify-center bg-slate-100 px-4 dark:bg-slate-900">
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

        <form onSubmit={handleSubmit}>
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

        <p className="mt-6 text-center text-xs text-slate-400">
          Giris, kurumunuzun kimlik saglayicisi uzerinden yapilir.
        </p>
      </div>
    </div>
  );
}
