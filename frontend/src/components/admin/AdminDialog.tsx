import { useState, useEffect, useMemo, useCallback } from 'react';
import { GlobalRole } from '@incompany/contracts';

import { Modal } from '../ui/Modal';
import { Button, Field, TextInput, SelectInput, SettingsSection } from '../ui/Form';
import { Avatar } from '../Avatar';
import { apiFetch } from '../../lib/api-client';

/**
 * Yönetim Paneli.
 *
 * KULLANICI OLUŞTURMA HAKKINDA ÖNEMLİ NOT:
 *   SSO yapılandırılmışsa kimlik doğrulama kurumsal IdP'de (Azure AD / Okta)
 *   yapılır. Ama bu dağıtım parola ile girişi de destekler (bkz. backend
 *   `AuthService.loginWithPassword`) — SSO her zaman kurulu olmayabilir.
 *   Bu yüzden burada oluşturulan kullanıcıya rastgele bir GEÇİCİ PAROLA
 *   üretilir ve bir kez gösterilir (bkz. `UsersService.createUser`).
 *
 *   SSO kurulu bir organizasyonda üretimde bu işlem SCIM ile otomatik
 *   yapılmalıdır — manuel provizyon, işten ayrılan çalışanın hesabının
 *   açık kalmasının bir numaralı sebebidir. Bu ekran, SCIM'in kapsamadığı
 *   istisnalar (yükleniciler, servis hesapları) ve acil durumlar içindir.
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
      const response = await apiFetch('/api/v1/admin/users');
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
      const response = await apiFetch(`/api/v1/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
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
        onUserCreated={() => void load()}
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
  onUserCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Yalnızca listeyi tazeler — diyaloğu KAPATMAZ (parola görüntülenmeye devam eder). */
  onUserCreated: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<GlobalRole>(GlobalRole.EMPLOYEE);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Oluşturma başarılı olunca geçici parola BİR KEZ burada gösterilir —
  // sunucu düz metni bir daha asla döndürmez, kaybedilirse yönetici parolayı
  // sıfırlamalıdır (o akış henüz yok).
  const [createdCredentials, setCreatedCredentials] = useState<{ email: string; password: string } | null>(null);

  const reset = (): void => {
    setDisplayName('');
    setEmail('');
    setTitle('');
    setRole(GlobalRole.EMPLOYEE);
    setErrors({});
    setCreatedCredentials(null);
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
      const response = await apiFetch('/api/v1/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      const data = (await response.json()) as { id: string; temporaryPassword: string };
      setCreatedCredentials({ email: email.trim().toLowerCase(), password: data.temporaryPassword });
      onUserCreated();
    } catch (err) {
      setErrors({ form: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const handleClose = (): void => {
    reset();
    onClose();
  };

  if (createdCredentials) {
    return (
      <Modal
        open={open}
        onClose={handleClose}
        title="Kullanıcı oluşturuldu"
        description="Bu geçici parola yalnızca BİR KEZ gösterilir — şimdi kopyalayıp kullanıcıya iletin."
        size="sm"
        footer={<Button variant="primary" onClick={handleClose}>Kapat</Button>}
      >
        <div className="space-y-3 px-5 py-4">
          <div className="rounded-lg bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Bu ekrandan ayrıldığınızda parola bir daha görüntülenemez. Kullanıcı ilk
            girişte bu parolayla oturum açabilir (parola değiştirme akışı henüz yok).
          </div>
          <Field label="E-posta">
            {({ id }) => <TextInput id={id} readOnly value={createdCredentials.email} onFocus={(e) => e.target.select()} />}
          </Field>
          <Field label="Geçici parola">
            {({ id }) => (
              <TextInput
                id={id}
                readOnly
                value={createdCredentials.password}
                className="font-mono"
                onFocus={(e) => e.target.select()}
              />
            )}
          </Field>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Yeni kullanıcı"
      description="Kullanıcıya bu uygulamada bir kayıt ve rol açılır."
      size="sm"
      footer={
        <>
          <Button onClick={handleClose}>İptal</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} loading={saving}>
            Oluştur
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <div className="rounded-lg bg-sky-50 px-3 py-2.5 text-xs leading-relaxed text-sky-900 dark:bg-sky-950 dark:text-sky-200">
          <p className="font-medium">Geçici bir parola üretilir</p>
          <p className="mt-0.5">
            Kimlik doğrulama kurumsal SSO (Azure AD / Okta) yapılandırılınca oradan da
            yapılabilir. Şimdilik kullanıcıya rastgele bir geçici parola atanır ve
            oluşturma sonrası bir kez gösterilir — kullanıcıya siz iletirsiniz.
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

        <Field label="Kurumsal e-posta" required error={errors.email} hint="Kullanıcı bu e-posta ile giriş yapacak.">
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

interface DepartmentRow {
  id: string;
  name: string;
  code: string;
  memberCount: number;
  managerName: string | null;
}

function DepartmentsPanel() {
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/departments');
        if (!response.ok) throw new Error(`Departmanlar yuklenemedi (${response.status})`);
        const data = (await response.json()) as { departments: DepartmentRow[] };
        setDepartments(data.departments);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <SettingsSection
        title="Departmanlar"
        description="Departman yapısı kurumsal dizinden (LDAP/SCIM) senkronize edilir."
      >
        {loading && <p className="text-xs text-slate-400">Yükleniyor…</p>}
        {error && <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">{error}</p>}
        {!loading && !error && departments.length === 0 && (
          <p className="text-xs text-slate-400">Henüz departman tanımlanmamış.</p>
        )}
        {departments.length > 0 && (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {departments.map((dept) => (
              <li key={dept.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                    {dept.name}
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      {dept.code}
                    </span>
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    Yönetici: {dept.managerName ?? '—'}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                  {dept.memberCount} kişi
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}

interface DlpRuleRow {
  key: string;
  name: string;
  action: 'ALLOW' | 'MASK' | 'WARN' | 'BLOCK';
  severity: number;
}

const ACTION_LABELS: Record<DlpRuleRow['action'], string> = {
  ALLOW: 'İzin ver',
  MASK: 'Maskele',
  WARN: 'Uyar',
  BLOCK: 'Engelle',
};

const ACTION_TONE: Record<DlpRuleRow['action'], string> = {
  BLOCK: 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  MASK: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  WARN: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  ALLOW: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

function SecurityPanel() {
  const [rules, setRules] = useState<DlpRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        // Gerçek DLP motorunun kuralları — sunucu her mesajı bunlara karşı
        // tarar (bkz. backend `DlpController`/`DlpService`). Bu panel daha
        // önce bu uç noktayı hiç çağırmıyordu, sabit örnek veri gösteriyordu.
        const response = await apiFetch('/api/v1/dlp/rules');
        if (!response.ok) throw new Error(`DLP kurallari yuklenemedi (${response.status})`);
        const data = (await response.json()) as { rules: DlpRuleRow[] };
        setRules(data.rules);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <SettingsSection
        title="DLP kuralları"
        description="Hassas veri içeren mesajlar gönderilmeden önce taranır ve maskelenir veya engellenir."
      >
        {loading && <p className="text-xs text-slate-400">Yükleniyor…</p>}
        {error && <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">{error}</p>}
        {!loading && !error && rules.length === 0 && (
          <p className="text-xs text-slate-400">
            Bu organizasyon için henüz özel bir DLP kuralı tanımlanmamış.
          </p>
        )}
        {rules.length > 0 && (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {rules.map((rule) => (
              <li key={rule.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-800 dark:text-slate-200">{rule.name}</p>
                  <p className="truncate font-mono text-[11px] text-slate-400">{rule.key}</p>
                </div>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${ACTION_TONE[rule.action]}`}>
                  {ACTION_LABELS[rule.action]}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Kurallar iki aşamalı çalışır: önce desen eşleştirmesi, ardından sağlama
          toplamı doğrulaması. Bu sayede rastgele 11 haneli bir sipariş numarası
          TCKN sanılıp engellenmez.
        </p>
      </SettingsSection>
    </div>
  );
}
