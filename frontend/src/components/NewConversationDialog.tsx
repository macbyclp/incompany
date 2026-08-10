import { useState, useEffect, useMemo } from 'react';
import { ChannelType, ChannelVisibility, type Uuid } from '@incompany/contracts';

import { Modal } from './ui/Modal';
import { Button, Field, TextInput, SelectInput, Toggle } from './ui/Form';
import { Avatar } from './Avatar';
import { useAuth } from '../store/auth.store';
import { apiFetch } from '../lib/api-client';

/**
 * Yeni Sohbet Diyaloğu.
 *
 * Kanal oluşturma ve direkt mesaj başlatma AYNI diyalogda toplandı:
 * kullanıcının zihnindeki eylem "yeni bir konuşma başlat"tır, "kanal mı
 * DM mi" ayrımı ikincil bir karardır. İki ayrı menü öğesi, kullanıcıyı
 * daha bir şey yazmadan karar vermeye zorlar.
 */

interface DirectoryUser {
  id: Uuid;
  displayName: string;
  email: string;
  title?: string;
}

interface NewConversationDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (channelId: Uuid) => void;
}

export function NewConversationDialog({ open, onClose, onCreated }: NewConversationDialogProps) {
  const [mode, setMode] = useState<'channel' | 'dm'>('channel');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Yeni sohbet"
      size="md"
    >
      <div className="px-5 pt-4">
        {/* Sekme değiştirici */}
        <div
          className="mb-4 inline-flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800"
          role="tablist"
          aria-label="Sohbet türü"
        >
          {([
            { id: 'channel' as const, label: 'Kanal oluştur' },
            { id: 'dm' as const, label: 'Direkt mesaj' },
          ]).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={mode === item.id}
              onClick={() => setMode(item.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors
                ${mode === item.id
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'channel' ? (
        <ChannelForm onClose={onClose} onCreated={onCreated} />
      ) : (
        <DmPicker onClose={onClose} onCreated={onCreated} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
//  Kanal oluşturma
// ---------------------------------------------------------------------------

function ChannelForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (channelId: Uuid) => void;
}) {
  const can = useAuth((s) => s.can);

  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [type, setType] = useState<ChannelType>(ChannelType.GROUP);
  const [isPrivate, setIsPrivate] = useState(true);
  const [e2ee, setE2ee] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  /** Kanal adı önizlemesi — kullanıcı slug'ı yazmadan önce görür. */
  const slug = useMemo(
    () =>
      name
        .toLocaleLowerCase('tr-TR')
        .replace(/[çğıöşü]/gu, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c] ?? c)
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 60),
    [name],
  );

  const handleSubmit = async (): Promise<void> => {
    if (name.trim().length < 2) {
      setErrors({ name: 'Kanal adı en az 2 karakter olmalı' });
      return;
    }

    setSaving(true);
    setErrors({});
    try {
      const response = await apiFetch('/api/v1/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          name: name.trim(),
          topic: topic.trim() || undefined,
          visibility: isPrivate ? ChannelVisibility.PRIVATE : ChannelVisibility.PUBLIC,
          e2eeEnabled: e2ee,
        }),
      });

      if (response.status === 409) {
        setErrors({ name: 'Bu isimde bir kanal zaten var' });
        return;
      }
      if (!response.ok) throw new Error('Kanal oluşturulamadı');

      const channel = (await response.json()) as { id: Uuid };
      onCreated(channel.id);
    } catch (err) {
      setErrors({ form: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="space-y-4 px-5 pb-4">
        {errors.form && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-200" role="alert">
            {errors.form}
          </p>
        )}

        <Field
          label="Kanal adı"
          required
          error={errors.name}
          hint={slug ? `Adres: #${slug}` : 'Küçük harf ve tire kullanılır.'}
        >
          {({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="örn. proje-atlas"
              maxLength={80}
              autoComplete="off"
            />
          )}
        </Field>

        <Field label="Konu" hint="Kanalın ne için olduğunu bir cümleyle anlatın.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Atlas projesi geliştirme ve planlama"
              maxLength={250}
            />
          )}
        </Field>

        <Field label="Kanal türü">
          {({ id }) => (
            <SelectInput id={id} value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
              <option value={ChannelType.GROUP}>Grup — herkes yazabilir</option>
              <option value={ChannelType.DEPARTMENT}>Departman kanalı</option>
              {can('announcement.post') && (
                <option value={ChannelType.ANNOUNCEMENT}>
                  Duyuru — yalnızca yetkililer yazabilir
                </option>
              )}
            </SelectInput>
          )}
        </Field>

        <div className="rounded-lg border border-slate-200 px-3 dark:border-slate-800">
          <Toggle
            checked={isPrivate}
            onChange={setIsPrivate}
            label="Özel kanal"
            description="Kapalıyken organizasyondaki herkes kanalı bulup katılabilir."
          />
        </div>

        {/* E2EE geri alınamaz bir karardır — uyarı, seçenekle BİRLİKTE gösterilir,
            sonradan bir onay diyaloğuna ertelenmez. */}
        <div className="rounded-lg border border-slate-200 px-3 dark:border-slate-800">
          <Toggle
            checked={e2ee}
            onChange={setE2ee}
            label="Uçtan uca şifreleme (E2EE)"
            description="Sunucu içeriği göremez. Bu kanalda arama, DLP taraması ve arşivleme ÇALIŞMAZ."
          />
          {e2ee && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <span className="font-medium">Bu ayar sonradan değiştirilemez.</span>{' '}
              Uyum ve e-keşif gereksinimleriniz varsa bu kanalı kullanmayın.
            </p>
          )}
        </div>
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
        <Button onClick={onClose}>İptal</Button>
        <Button variant="primary" onClick={() => void handleSubmit()} loading={saving}>
          Kanalı oluştur
        </Button>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------------------
//  Direkt mesaj
// ---------------------------------------------------------------------------

function DmPicker({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (channelId: Uuid) => void;
}) {
  const currentUserId = useAuth((s) => s.userId);
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<Uuid | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/users');
        if (response.ok) {
          const data = (await response.json()) as { users: DirectoryUser[] };
          // Kendini listede gösterme — kendinle DM açılamaz.
          setPeople(data.users.filter((u) => u.id !== currentUserId));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [currentUserId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr-TR');
    if (!q) return people;
    return people.filter(
      (p) =>
        p.displayName.toLocaleLowerCase('tr-TR').includes(q) ||
        p.email.toLocaleLowerCase('tr-TR').includes(q),
    );
  }, [people, query]);

  const openDm = async (userId: Uuid): Promise<void> => {
    setOpening(userId);
    try {
      const response = await apiFetch(`/api/v1/channels/dm/${userId}`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('DM açılamadı');
      const channel = (await response.json()) as { id: Uuid };
      onCreated(channel.id);
    } catch (error) {
      console.error('[dm] açma hatası:', error);
    } finally {
      setOpening(null);
    }
  };

  return (
    <>
      <div className="px-5 pb-3">
        <TextInput
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="İsim veya e-posta ile ara"
          aria-label="Kişi ara"
          autoFocus
        />
      </div>

      <div className="max-h-80 overflow-y-auto px-2 pb-2">
        {loading ? (
          <p className="px-3 py-6 text-center text-sm text-slate-400">Yükleniyor…</p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-slate-400">Kimse bulunamadı.</p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  onClick={() => void openDm(person.id)}
                  disabled={opening !== null}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left
                             hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800"
                >
                  <Avatar name={person.displayName} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                      {person.displayName}
                    </span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {person.title ? `${person.title} · ` : ''}
                      {person.email}
                    </span>
                  </span>
                  {opening === person.id && (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600 motion-reduce:animate-none" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="flex items-center justify-end border-t border-slate-200 px-5 py-3 dark:border-slate-800">
        <Button onClick={onClose}>Kapat</Button>
      </footer>
    </>
  );
}
