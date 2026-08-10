import { useState, useEffect, type ReactNode } from 'react';
import { PresenceStatus } from '@incompany/contracts';

import { Modal } from '../ui/Modal';
import { Button, Field, TextInput, SelectInput, Toggle, SettingsSection } from '../ui/Form';
import { Avatar } from '../Avatar';
import { usePreferences, type ThemePreference } from '../../store/preferences.store';
import { useAuth, authStore } from '../../store/auth.store';
import { realtimeClient } from '../../realtime/socket';
import { apiFetch } from '../../lib/api-client';

/**
 * Ayarlar Diyaloğu.
 *
 * SEKME YAPISI, tek uzun sayfa yerine tercih edildi: kullanıcı aradığı
 * ayarı taramak yerine kategoriden bulur. Beş sekmeden fazlası olsaydı
 * yan menüye geçmek gerekirdi.
 *
 * Profil değişiklikleri AÇIK KAYDETME gerektirir (dirty state + Kaydet).
 * Görünüm ve bildirim tercihleri ANINDA uygulanır — bir anahtarı çevirip
 * ayrıca "Kaydet"e basmak gereksiz bir adımdır ve kullanıcılar unutur.
 */

type Tab = 'profile' | 'appearance' | 'notifications' | 'status' | 'security';

const TABS: Array<{ id: Tab; label: string; icon: ReactNode }> = [
  { id: 'profile', label: 'Profil', icon: '👤' },
  { id: 'appearance', label: 'Görünüm', icon: '🎨' },
  { id: 'notifications', label: 'Bildirimler', icon: '🔔' },
  { id: 'status', label: 'Durum', icon: '🟢' },
  { id: 'security', label: 'Güvenlik', icon: '🔒' },
];

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('profile');

  return (
    <Modal open={open} onClose={onClose} title="Ayarlar" size="lg">
      <div className="flex min-h-[420px]">
        {/* --- Sekme listesi --- */}
        <nav
          className="w-44 shrink-0 border-r border-slate-200 p-2 dark:border-slate-800"
          aria-label="Ayar kategorileri"
        >
          <ul className="space-y-0.5">
            {TABS.map((item) => (
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

        {/* --- İçerik --- */}
        <div className="min-w-0 flex-1 px-5 py-1">
          {tab === 'profile' && <ProfileTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'status' && <StatusTab />}
          {tab === 'security' && <SecurityTab onClose={onClose} />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
//  Profil
// ---------------------------------------------------------------------------

function ProfileTab() {
  const displayName = useAuth((s) => s.displayName);
  const email = useAuth((s) => s.email);

  const [name, setName] = useState(displayName);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setName(displayName), [displayName]);

  const isDirty = name !== displayName;

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch('/api/v1/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name.trim(), title: title.trim() || undefined }),
      });
      if (!response.ok) throw new Error('Profil güncellenemedi');

      authStore.setState({ displayName: name.trim() });
      setSaved(true);
      // Onay mesajı kalıcı olmamalı — 2 sn sonra kaybolur.
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <SettingsSection title="Profil bilgileri">
        <div className="mb-4 flex items-center gap-4">
          <Avatar name={name || 'Kullanıcı'} size="lg" />
          <div className="text-xs text-slate-500 dark:text-slate-400">
            <p className="font-medium text-slate-700 dark:text-slate-300">Profil fotoğrafı</p>
            <p className="mt-0.5">
              Kurumsal dizinden senkronize edilir. Değiştirmek için BT ekibiyle iletişime geçin.
            </p>
          </div>
        </div>

        <Field label="Görünen ad" required hint="Mesajlarınızda ve kanal listesinde görünür.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          )}
        </Field>

        <Field label="Unvan" hint="Mesajlarınızın yanında küçük puntoyla gösterilir.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="örn. Yazılım Mimarı"
              maxLength={60}
            />
          )}
        </Field>

        <Field label="E-posta" hint="Kimlik sağlayıcıdan gelir, buradan değiştirilemez.">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} value={email} disabled readOnly />
          )}
        </Field>

        <div className="flex items-center gap-3 pt-1">
          <Button variant="primary" onClick={() => void handleSave()} disabled={!isDirty} loading={saving}>
            Kaydet
          </Button>
          {saved && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400" role="status">
              ✓ Kaydedildi
            </span>
          )}
          {error && (
            <span className="text-xs text-rose-600" role="alert">
              {error}
            </span>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Görünüm
// ---------------------------------------------------------------------------

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; hint: string }> = [
  { value: 'light', label: 'Açık', hint: 'Her zaman açık tema' },
  { value: 'dark', label: 'Koyu', hint: 'Her zaman koyu tema' },
  { value: 'system', label: 'Sistem', hint: 'İşletim sistemini izle' },
];

function AppearanceTab() {
  const theme = usePreferences((s) => s.theme);
  const compactMode = usePreferences((s) => s.compactMode);
  const enterToSend = usePreferences((s) => s.enterToSend);
  const linkPreviews = usePreferences((s) => s.linkPreviews);
  const setPref = usePreferences((s) => s.set);

  return (
    <div>
      <SettingsSection title="Tema">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Tema seçimi">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={theme === option.value}
              onClick={() => setPref('theme', option.value)}
              className={`rounded-xl border p-3 text-left transition-colors
                ${theme === option.value
                  ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500/20 dark:bg-indigo-950/50'
                  : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'}`}
            >
              <ThemeSwatch variant={option.value} />
              <span className="mt-2 block text-sm font-medium text-slate-800 dark:text-slate-200">
                {option.label}
              </span>
              <span className="block text-[11px] text-slate-500 dark:text-slate-400">{option.hint}</span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Mesaj görünümü">
        <Toggle
          checked={compactMode}
          onChange={(v) => setPref('compactMode', v)}
          label="Sıkışık mod"
          description="Mesajlar arasındaki boşluğu azaltır, ekrana daha fazla içerik sığar."
        />
        <Toggle
          checked={enterToSend}
          onChange={(v) => setPref('enterToSend', v)}
          label="Enter ile gönder"
          description="Kapalıyken Enter yeni satır ekler, göndermek için Ctrl+Enter kullanılır."
        />
        <Toggle
          checked={linkPreviews}
          onChange={(v) => setPref('linkPreviews', v)}
          label="Bağlantı önizlemeleri"
          description="Kapalıyken dış sitelere hiçbir istek yapılmaz — gizlilik açısından daha güvenli."
        />
      </SettingsSection>
    </div>
  );
}

function ThemeSwatch({ variant }: { variant: ThemePreference }) {
  if (variant === 'system') {
    return (
      <span className="flex h-10 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
        <span className="flex-1 bg-white" />
        <span className="flex-1 bg-slate-900" />
      </span>
    );
  }
  return (
    <span
      className={`block h-10 rounded-lg border border-slate-200 dark:border-slate-700 ${
        variant === 'dark' ? 'bg-slate-900' : 'bg-white'
      }`}
    />
  );
}

// ---------------------------------------------------------------------------
//  Bildirimler
// ---------------------------------------------------------------------------

function NotificationsTab() {
  const notifications = usePreferences((s) => s.notifications);
  const setNotification = usePreferences((s) => s.setNotification);
  const [permission, setPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );

  const requestPermission = async (): Promise<void> => {
    const result = await Notification.requestPermission();
    setPermission(result);
  };

  return (
    <div>
      <SettingsSection title="Masaüstü bildirimleri">
        {permission === 'denied' && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Tarayıcı bildirimleri engelledi. Açmak için adres çubuğundaki site
            ayarlarından izin vermeniz gerekir.
          </div>
        )}
        {permission === 'default' && (
          <Button variant="secondary" onClick={() => void requestPermission()}>
            Bildirim iznini ver
          </Button>
        )}

        <Toggle
          checked={notifications.desktop}
          onChange={(v) => setNotification('desktop', v)}
          label="Masaüstü bildirimi göster"
          disabled={permission !== 'granted'}
        />
        <Toggle
          checked={notifications.sound}
          onChange={(v) => setNotification('sound', v)}
          label="Bildirim sesi"
        />
        <Toggle
          checked={notifications.mentionsOnly}
          onChange={(v) => setNotification('mentionsOnly', v)}
          label="Yalnızca bahsedilmelerde bildir"
          description="Açıkken yalnızca @adınız geçtiğinde ve direkt mesajlarda bildirim alırsınız."
        />
      </SettingsSection>

      <SettingsSection
        title="Rahatsız etmeyin"
        description="Bu saatler arasında bildirim gönderilmez. Mesajlar yine de ulaşır."
      >
        <Toggle
          checked={notifications.quietHoursEnabled}
          onChange={(v) => setNotification('quietHoursEnabled', v)}
          label="Sessiz saatleri etkinleştir"
        />

        {notifications.quietHoursEnabled && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Başlangıç">
              {({ id }) => (
                <TextInput
                  id={id}
                  type="time"
                  value={notifications.quietHoursStart}
                  onChange={(e) => setNotification('quietHoursStart', e.target.value)}
                />
              )}
            </Field>
            <Field label="Bitiş">
              {({ id }) => (
                <TextInput
                  id={id}
                  type="time"
                  value={notifications.quietHoursEnd}
                  onChange={(e) => setNotification('quietHoursEnd', e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Durum
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = [
  { value: PresenceStatus.ONLINE, label: 'Çevrimiçi', dot: 'bg-emerald-500' },
  { value: PresenceStatus.AWAY, label: 'Dışarıda', dot: 'bg-amber-500' },
  { value: PresenceStatus.BUSY, label: 'Meşgul', dot: 'bg-rose-500' },
  { value: PresenceStatus.DND, label: 'Rahatsız etmeyin', dot: 'bg-rose-600' },
];

function StatusTab() {
  const [status, setStatus] = useState<PresenceStatus>(PresenceStatus.ONLINE);
  const [customText, setCustomText] = useState('');
  const [expiry, setExpiry] = useState('never');
  const [saved, setSaved] = useState(false);

  const handleApply = (): void => {
    const until =
      expiry === 'never'
        ? undefined
        : new Date(Date.now() + Number(expiry) * 60_000).toISOString();

    realtimeClient.setPresence(status, customText.trim() || undefined, until);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <SettingsSection title="Varlık durumu">
        <div className="space-y-1" role="radiogroup" aria-label="Durum seçimi">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={status === option.value}
              onClick={() => setStatus(option.value)}
              className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors
                ${status === option.value
                  ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/50'
                  : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'}`}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${option.dot}`} aria-hidden="true" />
              <span className="text-slate-800 dark:text-slate-200">{option.label}</span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Özel durum mesajı">
        <Field label="Mesaj" hint="Adınızın yanında görünür. En fazla 120 karakter.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="örn. Toplantıda · 15:00'te dönerim"
              maxLength={120}
            />
          )}
        </Field>

        <Field label="Otomatik temizle">
          {({ id }) => (
            <SelectInput id={id} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="never">Temizleme</option>
              <option value="30">30 dakika sonra</option>
              <option value="60">1 saat sonra</option>
              <option value="240">4 saat sonra</option>
              <option value="1440">Bugün sonunda</option>
            </SelectInput>
          )}
        </Field>

        <div className="flex items-center gap-3 pt-1">
          <Button variant="primary" onClick={handleApply}>
            Durumu uygula
          </Button>
          {saved && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400" role="status">
              ✓ Uygulandı
            </span>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Güvenlik
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  deviceLabel: string | null;
  ipAddress: string | null;
  createdAt: string;
}

function SecurityTab({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const logout = useAuth((s) => s.logout);

  useEffect(() => {
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/auth/sessions');
        if (response.ok) {
          const data = (await response.json()) as { sessions: SessionRow[] };
          setSessions(data.sessions);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleLogoutAll = async (): Promise<void> => {
    await apiFetch('/api/v1/auth/logout-all', { method: 'POST' });
    onClose();
    logout('user_requested');
  };

  return (
    <div>
      <SettingsSection
        title="Etkin oturumlar"
        description="Hesabınıza bağlı cihazlar. Tanımadığınız bir cihaz görüyorsanız hemen tüm oturumları sonlandırın."
      >
        {loading ? (
          <p className="text-xs text-slate-400">Yükleniyor…</p>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-slate-400">Etkin oturum bilgisi alınamadı.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-800 dark:text-slate-200">
                    {session.deviceLabel ?? 'Bilinmeyen cihaz'}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {session.ipAddress ?? '—'} ·{' '}
                    {new Date(session.createdAt).toLocaleString('tr-TR')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        <Button variant="danger" onClick={() => void handleLogoutAll()}>
          Tüm cihazlardan çıkış yap
        </Button>
      </SettingsSection>

      <SettingsSection title="Şifreleme">
        <div className="rounded-lg bg-slate-50 px-3 py-3 text-xs leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          <p className="mb-1.5 font-medium text-slate-800 dark:text-slate-200">
            Mesajlarınız AES-256-GCM ile şifrelenir
          </p>
          <p>
            Anahtarlar donanım destekli anahtar yönetim servisinde (KMS) saklanır ve
            uygulama sunucusuna düz olarak inmez. Veritabanı sızıntısı durumunda
            mesaj içerikleri okunamaz.
          </p>
          <p className="mt-2">
            <span className="font-medium">🔒 E2EE</span> etiketli kanallarda içerik
            yalnızca cihazlarda çözülür; bu kanallar aranamaz ve arşivlenemez.
          </p>
        </div>
      </SettingsSection>
    </div>
  );
}
