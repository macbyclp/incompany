import { useState, useEffect, useMemo, useCallback } from 'react';
import { GlobalRole } from '@incompany/contracts';

import { Modal } from '../ui/Modal';
import { Button, Field, TextInput, SelectInput, SettingsSection } from '../ui/Form';
import { Avatar } from '../Avatar';

/**
 * Yönetim Paneli.
 *
 * KULLANICI OLUŞTURMA HAKKINDA ÖNEMLİ NOT:
 *   Bu form PAROLA ALMAZ ve almamalıdır. Kimlik doğrulama kurumsal IdP'de
 *   (Azure AD / Okta) yapılır; burada yapılan iş "provizyon"dur: kullanıcıya
 *   bu uygulamada bir kayıt ve rol açmak. Parola, MFA ve hesap kilitleme
 *   IdP'nin sorumluluğundadır.
 *
 *   Üretimde bu işlemin tamamı SCIM ile otomatik yapılmalıdır — manuel
 *   provizyon, işten ayrılan çalışanın hesabının açık kalmasının bir
 *   numaralı sebebidir. Bu ekran, SCIM'in kapsamadığı istisnalar
 *   (yükleniciler, servis hesapları) ve acil durumlar içindir.
 */

type Tab = 'users' | 'departments' | 'security';

interface AdminUser {
  id: string;
  displayName: string;
  email: string;
  title?: string;
  departmentName?: string;
  roles: GlobalRole[];
  status: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED';
  lastLoginAt?: string;
}

const ROLE_LABELS: Record<GlobalRole, string> = {
  [GlobalRole.ADMIN]: 'Yönetici',
  [GlobalRole.DEPT_MANAGER]: 'Departman Yöneticisi',
  [GlobalRole.EMPLOYEE]: 'Çalışan',
};

const STATUS_LABELS = {
  ACTIVE: { label: 'Aktif', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
  SUSPENDED: { label: 'Askıda', className: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300' },
  DEPROVISIONED: { label: 'Kapatıldı', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
} as const;

export function AdminDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('users');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Yönetim"
      description="Kullanıcılar, departmanlar ve güvenlik politikaları"
      size="lg"
    >
      <div className="flex min-h-[460px]">
        <nav className="w-44 shrink-0 border-r border-slate-200 p-2 dark:border-slate-800" aria-label="Yönetim bölümleri">
          <ul className="space-y-0.5">
            {([
              { id: 'users' as const, label: 'Kullanıcılar', icon: '👥' },
              { id: 'departments' as const, label: 'Departmanlar', icon: '🏢' },
              { id: 'security' as const, label: 'Güvenlik', icon: '🛡️' },
            ]).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setTab(item.id)}
                  aria-current={tab === item.id ? 'page' : undefined}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors
                    ${tab === item.id
                      ? 'bg-indigo-50 font-medium text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 px-5 py-4">
          {tab === 'users' && <UsersPanel />}
          {tab === 'departments' && <DepartmentsPanel />}
          {tab === 'security' && <SecurityPanel />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
//  Kullanıcılar
// ---------------------------------------------------------------------------

function UsersPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/v1/admin/users', { credentials: 'include' });
      if (!response.ok) throw new Error(`Kullanıcılar yüklenemedi (${response.status})`);
      const data = (await response.json()) as { users: AdminUser[] };
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr-TR');
    if (!q) return users;
    return users.filter(
      (u) =>
        u.displayName.toLocaleLowerCase('tr-TR').includes(q) ||
        u.email.toLocaleLowerCase('tr-TR').includes(q),
    );
  }, [users, query]);

  const updateUser = async (userId: string, patch: Partial<AdminUser>): Promise<void> => {
    // İyimser güncelleme: yönetici tıkladığı anda listeyi güncelle.
    // Hata olursa `load()` ile gerçek duruma geri dönülür.
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, ...patch } : u)));
    try {
      const response = await fetch(`/api/v1/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error('Güncelleme başarısız');
    } catch (err) {
      setError((err as Error).message);
      void load();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <TextInput
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ad veya e-posta ara"
          aria-label="Kullanıcı ara"
          className="flex-1"
        />
        <Button variant="primary" onClick={() => setCreating(true)}>
          + Kullanıcı ekle
        </Button>
      </div>

      {error && (
        <p className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-200" role="alert">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
        {loading ? (
          <p className="p-4 text-sm text-slate-400">Yükleniyor…</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-sm text-slate-400">Eşleşen kullanıcı yok.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">Kullanıcı</th>
                <th scope="col" className="px-3 py-2 font-semibold">Rol</th>
                <th scope="col" className="px-3 py-2 font-semibold">Durum</th>
                <th scope="col" className="px-3 py-2 font-semibold"><span className="sr-only">İşlemler</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filtered.map((user) => (
                <tr key={user.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={user.displayName} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-800 dark:text-slate-200">
                          {user.displayName}
                        </p>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{user.email}</p>
                      </div>
                    </div>
                  </td>

                  <td className="px-3 py-2">
                    <SelectInput
                      value={user.roles[0] ?? GlobalRole.EMPLOYEE}
                      onChange={(e) => void updateUser(user.id, { roles: [e.target.value as GlobalRole] })}
                      aria-label={`${user.displayName} rolü`}
                      className="!py-1 !text-xs"
                    >
                      {Object.entries(ROLE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </SelectInput>
                  </td>

                  <td className="px-3 py-2">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_LABELS[user.status].className}`}>
                      {STATUS_LABELS[user.status].label}
                    </span>
                  </td>

                  <td className="px-3 py-2 text-right">
                    {user.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        onClick={() => void updateUser(user.id, { status: 'SUSPENDED' })}
                        className="text-xs font-medium text-amber-600 hover:underline"
                      >
                        Askıya al
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void updateUser(user.id, { status: 'ACTIVE' })}
                        className="text-xs font-medium text-emerald-600 hover:underline"
                      >
                        Aktifleştir
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-2 text-[11px] text-slate-400">
        {filtered.length} kullanıcı gösteriliyor. Rol değişiklikleri anında geçerli olur
        ve kullanıcının tüm oturumlarını sonlandırır.
      </p>

      <CreateUserDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void load();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Kullanıcı oluşturma
// ---------------------------------------------------------------------------

function CreateUserDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<GlobalRole>(GlobalRole.EMPLOYEE);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const reset = (): void => {
    setDisplayName('');
    setEmail('');
    setTitle('');
    setRole(GlobalRole.EMPLOYEE);
    setErrors({});
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (displayName.trim().length < 2) next.displayName = 'En az 2 karakter olmalı';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email.trim())) next.email = 'Geçerli bir e-posta girin';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (): Promise<void> => {
    if (!validate()) return;

    setSaving(true);
    try {
      const response = await fetch('/api/v1/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          displayName: displayName.trim(),
          email: email.trim().toLowerCase(),
          title: title.trim() || undefined,
          roles: [role],
        }),
      });

      if (response.status === 409) {
        setErrors({ email: 'Bu e-posta zaten kayıtlı' });
        return;
      }
      if (!response.ok) throw new Error('Kullanıcı oluşturulamadı');

      reset();
      onCreated();
    } catch (err) {
      setErrors({ form: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Yeni kullanıcı"
      description="Kullanıcıya bu uygulamada bir kayıt ve rol açılır."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>İptal</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} loading={saving}>
            Oluştur
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <div className="rounded-lg bg-sky-50 px-3 py-2.5 text-xs leading-relaxed text-sky-900 dark:bg-sky-950 dark:text-sky-200">
          <p className="font-medium">Parola belirlenmez</p>
          <p className="mt-0.5">
            Kimlik doğrulama kurumsal hesabınız (SSO) üzerinden yapılır. Kullanıcı ilk
            girişte kendi kurumsal kimliğiyle oturum açar.
          </p>
        </div>

        {errors.form && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-200" role="alert">
            {errors.form}
          </p>
        )}

        <Field label="Ad soyad" required error={errors.displayName}>
          {({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ayşe Yılmaz"
              autoComplete="off"
            />
          )}
        </Field>

        <Field label="Kurumsal e-posta" required error={errors.email} hint="IdP'deki hesapla eşleşmelidir.">
          {({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              type="email"
              aria-describedby={describedBy}
              invalid={invalid}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ayse@sirket.com"
              autoComplete="off"
            />
          )}
        </Field>

        <Field label="Unvan">
          {({ id }) => (
            <TextInput id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Backend Geliştirici" />
          )}
        </Field>

        <Field label="Rol" hint="Yönetici rolü tüm denetim kayıtlarına ve DLP ayarlarına erişim verir.">
          {({ id, describedBy }) => (
            <SelectInput
              id={id}
              aria-describedby={describedBy}
              value={role}
              onChange={(e) => setRole(e.target.value as GlobalRole)}
            >
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </SelectInput>
          )}
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function DepartmentsPanel() {
  const departments = [
    { name: 'Bilgi Teknolojileri', code: 'BT', members: 24, manager: 'Mehmet Ali Çalapverd' },
    { name: 'İnsan Kaynakları', code: 'IK', members: 8, manager: 'Can Demir' },
    { name: 'Ürün', code: 'URN', members: 15, manager: 'Zeynep Kaya' },
    { name: 'Finans', code: 'FIN', members: 11, manager: '—' },
  ];

  return (
    <div>
      <SettingsSection
        title="Departmanlar"
        description="Departman yapısı kurumsal dizinden (LDAP/SCIM) senkronize edilir."
      >
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {departments.map((dept) => (
            <li key={dept.code} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                  {dept.name}
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {dept.code}
                  </span>
                </p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  Yönetici: {dept.manager}
                </p>
              </div>
              <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                {dept.members} kişi
              </span>
            </li>
          ))}
        </ul>
      </SettingsSection>
    </div>
  );
}

function SecurityPanel() {
  const rules = [
    { key: 'TCKN', name: 'T.C. Kimlik Numarası', action: 'Maskele', severity: 5 },
    { key: 'CREDIT_CARD', name: 'Kredi Kartı Numarası', action: 'Engelle', severity: 5 },
    { key: 'IBAN_TR', name: 'IBAN (TR)', action: 'Maskele', severity: 4 },
    { key: 'AWS_ACCESS_KEY', name: 'AWS Erişim Anahtarı', action: 'Engelle', severity: 5 },
    { key: 'PRIVATE_KEY', name: 'Özel Anahtar (PEM)', action: 'Engelle', severity: 5 },
    { key: 'JWT_TOKEN', name: 'JWT Token', action: 'Engelle', severity: 5 },
    { key: 'GENERIC_SECRET', name: 'Şifre / API Anahtarı Ataması', action: 'Uyar', severity: 3 },
  ];

  const actionTone: Record<string, string> = {
    Engelle: 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
    Maskele: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    Uyar: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  };

  return (
    <div>
      <SettingsSection
        title="DLP kuralları"
        description="Hassas veri içeren mesajlar gönderilmeden önce taranır ve maskelenir veya engellenir."
      >
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {rules.map((rule) => (
            <li key={rule.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-800 dark:text-slate-200">{rule.name}</p>
                <p className="truncate font-mono text-[11px] text-slate-400">{rule.key}</p>
              </div>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${actionTone[rule.action]}`}>
                {rule.action}
              </span>
            </li>
          ))}
        </ul>

        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Kurallar iki aşamalı çalışır: önce desen eşleştirmesi, ardından sağlama
          toplamı doğrulaması. Bu sayede rastgele 11 haneli bir sipariş numarası
          TCKN sanılıp engellenmez.
        </p>
      </SettingsSection>

      <SettingsSection title="Saklama politikası">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          {[
            ['Mesaj saklama', '2 yıl'],
            ['Dosya saklama', '1 yıl'],
            ['Denetim kaydı', '7 yıl'],
            ['Yasal muhafaza', 'Kapalı'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
              <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
              <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{value}</dd>
            </div>
          ))}
        </dl>
      </SettingsSection>
    </div>
  );
}
