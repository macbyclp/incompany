import { useState, type FormEvent } from 'react';

import { authStore } from '../store/auth.store';
import { Field, TextInput, Button } from './ui/Form';

/**
 * Kurulum Sihirbazı — İlk Çalıştırma Deneyimi.
 *
 * NE ZAMAN GÖRÜNÜR?
 *   Yalnızca veritabanında HİÇ organizasyon yokken — App.tsx bunu
 *   `/api/v1/setup/status` ile açılışta sorar. Bu ekranı bir kez tamamladıktan
 *   sonra sunucu tarafındaki tek-seferlik kapı (bkz. backend `SetupService`)
 *   uç noktayı kalıcı olarak kilitler; bu bileşen bir daha görünmez.
 *
 * NEDEN AYRI BİR EKRAN, GİRİŞ EKRANININ İÇİNE GÖMÜLÜ DEĞİL?
 *   Kavramsal olarak farklı iki eylem: "var olan bir hesapla gir" ile
 *   "sıfırdan bir organizasyon kur". İkisini tek forma sıkıştırmak,
 *   kurulumu az yapılan ama kritik bir akışı, sık yapılan girişin
 *   karmaşıklığına gömer.
 *
 * DEMO İLE KARIŞTIRILMASIN
 *   `npm run demo` bellek içi sahte verilerle çalışan AYRI bir sunucudur
 *   (`backend/scripts/dev-server.ts`) ve bu sihirbazı hiç çalıştırmaz.
 *   Gerçek dağıtım (`docker compose up` veya üretim) her zaman BU ekrandan
 *   başlar — sıfır kanal, sıfır kullanıcı, sıfır mesaj.
 */

interface SetupWizardProps {
  onComplete: () => void;
}

interface FormState {
  organizationName: string;
  adminDisplayName: string;
  adminEmail: string;
  adminPassword: string;
  adminPasswordConfirm: string;
}

const INITIAL_FORM: FormState = {
  organizationName: '',
  adminDisplayName: '',
  adminEmail: '',
  adminPassword: '',
  adminPasswordConfirm: '',
};

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): boolean => {
    const next: Partial<Record<keyof FormState, string>> = {};

    const orgName = form.organizationName.trim();
    if (orgName.length < 2) {
      next.organizationName = 'En az 2 karakter olmalı';
    } else if (/\s|\d/u.test(orgName)) {
      // Organizasyon adı URL slug'ına dönüşür (bkz. backend SetupService.
      // uniqueSlug) — boşluk ve rakam kasıtlı olarak yasaklanır, aksi halde
      // slug üretimi öngörülemez hale gelir.
      next.organizationName = 'Boşluk veya rakam içeremez (ör. OrnekSirket)';
    }
    if (form.adminDisplayName.trim().length < 2) {
      next.adminDisplayName = 'En az 2 karakter olmalı';
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(form.adminEmail.trim())) {
      next.adminEmail = 'Geçerli bir e-posta adresi girin';
    }
    if (form.adminPassword.length < 12) {
      next.adminPassword = 'En az 12 karakter olmalı';
    }
    if (form.adminPassword !== form.adminPasswordConfirm) {
      next.adminPasswordConfirm = 'Parolalar eşleşmiyor';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setSaving(true);
    try {
      const response = await fetch('/api/v1/setup/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          organizationName: form.organizationName.trim(),
          adminDisplayName: form.adminDisplayName.trim(),
          adminEmail: form.adminEmail.trim().toLowerCase(),
          adminPassword: form.adminPassword,
        }),
      });

      if (response.status === 409) {
        // Kilidi beklerken başka biri kurulumu bitirmiş — sayfayı yenile,
        // App.tsx normal giriş ekranını gösterecektir.
        setFormError('Kurulum başka bir oturumda tamamlandı. Sayfa yenileniyor…');
        setTimeout(() => window.location.reload(), 1500);
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Kurulum başarısız (${response.status})`);
      }

      const data = (await response.json()) as { accessToken: string; expiresAt: number; orgSlug: string };

      // Sonraki girişlerde (SSO veya parola) LoginScreen'in aynı anahtarı
      // okuyup organizasyon alanını otomatik doldurması için.
      try {
        localStorage.setItem('incompany:org', data.orgSlug);
      } catch {
        // Gizli sekmede depolama kapalı olabilir; kritik değil.
      }

      // Erişim token'ını depoya yaz, ardından tam profili (rol, izin) çek.
      // İki adıma bölünmesinin sebebi: `hydrateFromServer` mevcut
      // `accessToken`'ı okuyarak `/auth/me`'yi çağırır — token önce
      // yazılmalıdır.
      authStore.setState({ accessToken: data.accessToken, accessTokenExpiresAt: data.expiresAt });
      const hydrated = await authStore.getState().hydrateFromServer();

      if (!hydrated) {
        throw new Error('Kurulum tamamlandı ama oturum açılamadı. Lütfen giriş yapmayı deneyin.');
      }

      onComplete();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-slate-100 px-4 py-8 dark:bg-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white">
            iN
          </div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            iNCompany kurulumu
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Bu ekran yalnızca bir kez görünür. Organizasyonunuzu ve ilk
            yönetici hesabınızı oluşturun — sistem tamamen boş başlar.
          </p>
        </div>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          {formError && (
            <p
              className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-200"
              role="alert"
            >
              {formError}
            </p>
          )}

          <div className="mb-5">
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Organizasyon
            </h2>
            <Field
              label="Organizasyon adı"
              required
              error={errors.organizationName}
              hint="Boşluk ve rakam içeremez."
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.organizationName}
                  onChange={(e) => set('organizationName', e.target.value)}
                  placeholder="OrnekSirket"
                  autoComplete="organization"
                  autoFocus
                  maxLength={100}
                />
              )}
            </Field>
          </div>

          <div className="mb-5 space-y-4">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Yönetici hesabınız
            </h2>

            <Field label="Ad soyad" required error={errors.adminDisplayName}>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.adminDisplayName}
                  onChange={(e) => set('adminDisplayName', e.target.value)}
                  placeholder="Ayşe Yılmaz"
                  autoComplete="name"
                  maxLength={80}
                />
              )}
            </Field>

            <Field label="E-posta" required error={errors.adminEmail}>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  type="email"
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.adminEmail}
                  onChange={(e) => set('adminEmail', e.target.value)}
                  placeholder="ayse@sirket.com"
                  autoComplete="email"
                  maxLength={255}
                />
              )}
            </Field>

            <Field
              label="Parola"
              required
              error={errors.adminPassword}
              hint={!errors.adminPassword ? 'En az 12 karakter — karmaşıklık kuralı yok, uzunluk yeterlidir.' : undefined}
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  type="password"
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.adminPassword}
                  onChange={(e) => set('adminPassword', e.target.value)}
                  autoComplete="new-password"
                  maxLength={200}
                />
              )}
            </Field>

            <Field label="Parola (tekrar)" required error={errors.adminPasswordConfirm}>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  type="password"
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.adminPasswordConfirm}
                  onChange={(e) => set('adminPasswordConfirm', e.target.value)}
                  autoComplete="new-password"
                  maxLength={200}
                />
              )}
            </Field>
          </div>

          <Button type="submit" variant="primary" loading={saving} className="w-full justify-center">
            Kurulumu tamamla
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-400">
          Kimlik doğrulama daha sonra Ayarlar → Güvenlik'ten kurumsal SSO'ya
          (Azure AD / Okta) bağlanabilir. Bu hesap o zaman da çalışmaya devam eder.
        </p>
      </div>
    </div>
  );
}
