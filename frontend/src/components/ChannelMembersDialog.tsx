import { useState, useEffect, useMemo, useCallback } from 'react';
import { ChannelMemberRole, type Uuid } from '@incompany/contracts';

import { Modal } from './ui/Modal';
import { Button, TextInput } from './ui/Form';
import { Avatar } from './Avatar';
import { useAuth } from '../store/auth.store';
import { refreshChannels } from '../store/channels.store';
import { apiFetch } from '../lib/api-client';

/**
 * Kanal Üye Yönetimi.
 *
 * ÜYELİK DOĞRULAMASI SUNUCUDADIR — bkz. `ChannelService.listMembers`.
 * Kanal kimliğini tahmin eden üye olmayan biri bu listeyi göremez; sunucu
 * 403 döner ve burada yalnızca hata gösterilir. İstemci tarafında ayrıca
 * bir kontrol YOKTUR çünkü olsa bile atlatılabilir — güvenlik sınırı tektir.
 */

interface Member {
  userId: Uuid;
  displayName: string;
  email: string;
  title: string | null;
  role: ChannelMemberRole;
  joinedAt: string;
}

interface DirectoryUser {
  id: Uuid;
  displayName: string;
  email: string;
  title?: string;
}

const ROLE_LABELS: Record<ChannelMemberRole, string> = {
  [ChannelMemberRole.OWNER]: 'Sahip',
  [ChannelMemberRole.MODERATOR]: 'Moderatör',
  [ChannelMemberRole.MEMBER]: 'Üye',
  [ChannelMemberRole.READER]: 'Salt okuma',
};

export function ChannelMembersDialog({
  open,
  onClose,
  channelId,
  channelName,
}: {
  open: boolean;
  onClose: () => void;
  channelId: Uuid;
  channelName: string;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const currentUserId = useAuth((s) => s.userId);
  const canManage = useAuth((s) => s.can('channel.member.manage'));

  const myRole = useMemo(
    () => members.find((m) => m.userId === currentUserId)?.role,
    [members, currentUserId],
  );
  const isChannelStaff = myRole === ChannelMemberRole.OWNER || myRole === ChannelMemberRole.MODERATOR;
  const canRemove = canManage || isChannelStaff;

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const response = await apiFetch(`/api/v1/channels/${channelId}/members`);
      if (!response.ok) throw new Error(`Üyeler yüklenemedi (${response.status})`);
      const data = (await response.json()) as { members: Member[] };
      setMembers(data.members);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [open, channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRemove = async (userId: Uuid): Promise<void> => {
    // İyimser güncelleme: üye çıkarma nadir ve geri alınabilir bir işlemdir
    // (tekrar eklenebilir) — hata durumunda `load()` gerçek duruma döner.
    setMembers((prev) => prev.filter((m) => m.userId !== userId));
    try {
      const response = await apiFetch(`/api/v1/channels/${channelId}/members/${userId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Çıkarma başarısız');

      // Kenar çubuğundaki ve başlıktaki `memberCount` bu panelden AYRI bir
      // depoda (`channels.store`) tutulur. Burada tazelenmezse, panel
      // kapatıldığında başlık rozeti eski (yüksek) sayıyı göstermeye devam
      // eder — kullanıcı çıkarmanın işe yaramadığını sanır.
      void refreshChannels();
    } catch (err) {
      setError((err as Error).message);
      void load();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Üyeler — ${channelName}`}
      description={`${members.length} kişi`}
      size="md"
    >
      <div className="px-5 py-4">
        {canManage && (
          <Button variant="primary" onClick={() => setAdding(true)} className="mb-3 w-full justify-center">
            + Üye ekle
          </Button>
        )}

        {error && (
          <p className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-200" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <MembersSkeleton />
        ) : (
          <ul className="max-h-96 space-y-0.5 overflow-y-auto">
            {members.map((member) => (
              <li key={member.userId} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <Avatar name={member.displayName} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                    {member.displayName}
                    {member.userId === currentUserId && (
                      <span className="ml-1.5 text-xs font-normal text-slate-400">(siz)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {member.title ? `${member.title} · ` : ''}
                    {member.email}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium
                    ${member.role === ChannelMemberRole.OWNER || member.role === ChannelMemberRole.MODERATOR
                      ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                      : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'}`}
                >
                  {ROLE_LABELS[member.role]}
                </span>

                {canRemove && member.role !== ChannelMemberRole.OWNER && member.userId !== currentUserId && (
                  <button
                    type="button"
                    onClick={() => void handleRemove(member.userId)}
                    title="Kanaldan çıkar"
                    aria-label={`${member.displayName} kişisini kanaldan çıkar`}
                    className="shrink-0 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                  >
                    <RemoveIcon />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <AddMembersDialog
        open={adding}
        onClose={() => setAdding(false)}
        channelId={channelId}
        existingIds={members.map((m) => m.userId)}
        onAdded={() => {
          setAdding(false);
          void load();
          // Bkz. handleRemove'daki not: memberCount ayrı bir depodadır.
          void refreshChannels();
        }}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function AddMembersDialog({
  open,
  onClose,
  channelId,
  existingIds,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  channelId: Uuid;
  existingIds: Uuid[];
  onAdded: () => void;
}) {
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<Uuid>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/users');
        if (response.ok) {
          const data = (await response.json()) as { users: DirectoryUser[] };
          setPeople(data.users);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  const candidates = useMemo(() => {
    const existing = new Set(existingIds);
    const q = query.trim().toLocaleLowerCase('tr-TR');
    return people.filter((p) => {
      if (existing.has(p.id)) return false;
      if (!q) return true;
      return p.displayName.toLocaleLowerCase('tr-TR').includes(q) || p.email.toLocaleLowerCase('tr-TR').includes(q);
    });
  }, [people, existingIds, query]);

  const toggle = (id: Uuid): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async (): Promise<void> => {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      const response = await apiFetch(`/api/v1/channels/${channelId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: Array.from(selected) }),
      });
      if (!response.ok) throw new Error('Üye eklenemedi');
      onAdded();
    } catch (error) {
      console.error('[members] ekleme hatası:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Üye ekle"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>İptal</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} loading={saving} disabled={selected.size === 0}>
            {selected.size > 0 ? `${selected.size} kişiyi ekle` : 'Ekle'}
          </Button>
        </>
      }
    >
      <div className="px-5 pb-3 pt-1">
        <TextInput
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ad veya e-posta ile ara"
          aria-label="Kişi ara"
          autoFocus
        />
      </div>

      <div className="max-h-72 overflow-y-auto px-2 pb-2">
        {loading ? (
          <p className="px-3 py-6 text-center text-sm text-slate-400">Yükleniyor…</p>
        ) : candidates.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-slate-400">Eklenebilecek kimse yok.</p>
        ) : (
          <ul className="space-y-0.5">
            {candidates.map((person) => (
              <li key={person.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <input
                    type="checkbox"
                    checked={selected.has(person.id)}
                    onChange={() => toggle(person.id)}
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <Avatar name={person.displayName} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-800 dark:text-slate-200">
                      {person.displayName}
                    </span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {person.email}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function MembersSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-32 animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />
            <div className="h-2.5 w-44 animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M8 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm-6 12a6 6 0 0 1 10.7-3.7 1 1 0 0 1-1.4 1.4A4 4 0 0 0 4 16H2Zm14.3-6.7a1 1 0 0 1 1.4 1.4L16.4 12l1.3 1.3a1 1 0 0 1-1.4 1.4L15 13.4l-1.3 1.3a1 1 0 0 1-1.4-1.4l1.3-1.3-1.3-1.3a1 1 0 0 1 1.4-1.4l1.3 1.3 1.3-1.3Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
