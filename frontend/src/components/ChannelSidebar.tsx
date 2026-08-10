import { useEffect, useState, useMemo, type ReactNode } from 'react';
import { ChannelType, PresenceStatus, GlobalRole, type Uuid } from '@incompany/contracts';

import { useChatStore } from '../store/chat.store';
import { useAuth } from '../store/auth.store';
import { useDirectoryStore } from '../store/directory.store';
import { useChannelListStore, refreshChannels, type ChannelSummary } from '../store/channels.store';
import { Avatar } from './Avatar';
import { SettingsDialog } from './settings/SettingsDialog';
import { AdminDialog } from './admin/AdminDialog';
import { NewConversationDialog } from './NewConversationDialog';
import { apiFetch } from '../lib/api-client';

/**
 * Kanal Kenar Çubuğu.
 *
 * OKUNMAMIŞ SAYACI DEPODAN OKUNUR, SUNUCUDAN DEĞİL.
 *   Sunucu yalnızca `lastSeq` yayınlar; okunmamış sayısı istemcide
 *   `lastSeq - lastReadSeq` ile hesaplanır. Böylece kullanıcı bir mesajı
 *   okuduğunda sayaç ANINDA düşer, sunucu turunu beklemez.
 *
 * GRUPLAMA
 *   Sabitlenenler → Kanallar → Direkt Mesajlar. Düz bir liste, 30+ kanallı
 *   bir kullanıcıda gezinmeyi zorlaştırır; başlıklar hem tarama hızını
 *   artırır hem de ekran okuyucuya yapı verir.
 */

interface ChannelSidebarProps {
  activeChannelId: Uuid | null;
  onSelectChannel: (channelId: Uuid) => void;
}

export function ChannelSidebar({ activeChannelId, onSelectChannel }: ChannelSidebarProps) {
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<'none' | 'settings' | 'admin' | 'new'>('none');

  const displayName = useAuth((s) => s.displayName);
  const email = useAuth((s) => s.email);
  const logout = useAuth((s) => s.logout);
  const isAdmin = useAuth((s) => s.roles.includes(GlobalRole.ADMIN));
  const storeChannels = useChatStore((s) => s.channels);
  const connectionState = useChatStore((s) => s.connectionState);

  // Kanal listesi PAYLAŞILAN depoda tutulur, bileşen state'inde değil:
  // ChatWindow da açık kanalın adına ve tipine ihtiyaç duyar.
  const byId = useChannelListStore((s) => s.byId);
  const order = useChannelListStore((s) => s.order);
  const loading = useChannelListStore((s) => s.isLoading);
  const error = useChannelListStore((s) => s.error);

  useEffect(() => {
    void (async () => {
      const store = useChannelListStore.getState();
      try {
        const response = await apiFetch('/api/v1/channels');
        if (!response.ok) throw new Error(`Kanallar yüklenemedi (${response.status})`);

        const data = (await response.json()) as { channels: ChannelSummary[] };
        store.setChannels(data.channels);

        // DM karşı taraflarını dizine kaydet — adları göstermek için gerekli.
        for (const channel of data.channels) {
          if (channel.peerUserId) useDirectoryStore.getState().request(channel.peerUserId);
        }
      } catch (err) {
        store.setError((err as Error).message);
      }
    })();
  }, []);

  /**
   * Sunucudan gelen sayaç ile yerel durum birleştirilir; YEREL ÖNCELİKLİDİR.
   * Ardından üç gruba ayrılır ve her grup kendi içinde sıralanır.
   */
  const groups = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase('tr-TR');

    const enriched = order
      .map((id) => byId[id])
      .filter((c): c is ChannelSummary => Boolean(c))
      .map((channel) => ({
        ...channel,
        unreadCount: storeChannels[channel.id]?.unread ?? channel.unreadCount,
      }))
      .filter((channel) => {
        if (!query) return true;
        return (channel.name ?? '').toLocaleLowerCase('tr-TR').includes(query);
      });

    const byName = (a: ChannelSummary, b: ChannelSummary) =>
      (a.name ?? '').localeCompare(b.name ?? '', 'tr-TR');

    return {
      pinned: enriched.filter((c) => c.isPinned).sort(byName),
      channels: enriched.filter((c) => !c.isPinned && c.type !== ChannelType.DM).sort(byName),
      dms: enriched.filter((c) => !c.isPinned && c.type === ChannelType.DM),
    };
  }, [byId, order, storeChannels, filter]);

  const isEmpty =
    groups.pinned.length === 0 && groups.channels.length === 0 && groups.dms.length === 0;

  return (
    <nav
      className="flex w-[264px] shrink-0 flex-col border-r border-slate-200 bg-white
                 dark:border-slate-800 dark:bg-slate-900"
      aria-label="Kanallar"
    >
      {/* --- Çalışma alanı başlığı --- */}
      <header className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
          iN
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            iNCompany
          </p>
          <ConnectionPill state={connectionState} />
        </div>
      </header>

      {/* --- Arama + yeni sohbet --- */}
      <div className="flex items-center gap-1.5 px-3 py-2.5">
        <div className="relative flex-1">
          <span
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          >
            <SearchIcon />
          </span>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Kanal veya kişi ara"
            aria-label="Kanal veya kişi ara"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-3 text-sm
                       text-slate-900 placeholder:text-slate-400
                       focus:border-indigo-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20
                       dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </div>

        <button
          type="button"
          onClick={() => setDialog('new')}
          title="Yeni sohbet"
          aria-label="Yeni sohbet başlat"
          className="shrink-0 rounded-lg bg-indigo-600 p-1.5 text-white hover:bg-indigo-700"
        >
          <PlusIcon />
        </button>
      </div>

      {/* --- Liste --- */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {error && (
          <p className="mx-1 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-200">
            {error}
          </p>
        )}

        {loading && !error && <SidebarSkeleton />}

        {!loading && isEmpty && (
          <p className="px-3 py-6 text-center text-xs text-slate-400">
            {filter ? 'Eşleşen sonuç yok' : 'Henüz bir kanala üye değilsiniz'}
          </p>
        )}

        {groups.pinned.length > 0 && (
          <Section title="Sabitlenenler">
            {groups.pinned.map((c) => (
              <ChannelRow key={c.id} channel={c} isActive={c.id === activeChannelId} onSelect={onSelectChannel} />
            ))}
          </Section>
        )}

        {groups.channels.length > 0 && (
          <Section title="Kanallar">
            {groups.channels.map((c) => (
              <ChannelRow key={c.id} channel={c} isActive={c.id === activeChannelId} onSelect={onSelectChannel} />
            ))}
          </Section>
        )}

        {groups.dms.length > 0 && (
          <Section title="Direkt Mesajlar">
            {groups.dms.map((c) => (
              <ChannelRow key={c.id} channel={c} isActive={c.id === activeChannelId} onSelect={onSelectChannel} />
            ))}
          </Section>
        )}
      </div>

      {/* --- Kullanıcı --- */}
      <footer className="flex items-center gap-2.5 border-t border-slate-200 px-3 py-2.5 dark:border-slate-800">
        <Avatar name={displayName || 'Kullanıcı'} size="md" presence={PresenceStatus.ONLINE} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {displayName || 'Kullanıcı'}
          </p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">
            {email || 'Çevrimiçi'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {isAdmin && (
            <IconButton label="Yönetim" onClick={() => setDialog('admin')}>
              <ShieldIcon />
            </IconButton>
          )}
          <IconButton label="Ayarlar" onClick={() => setDialog('settings')}>
            <GearIcon />
          </IconButton>
          <IconButton label="Çıkış yap" onClick={() => logout('user_requested')}>
            <LogoutIcon />
          </IconButton>
        </div>
      </footer>

      <SettingsDialog open={dialog === 'settings'} onClose={() => setDialog('none')} />
      <AdminDialog open={dialog === 'admin'} onClose={() => setDialog('none')} />
      <NewConversationDialog
        open={dialog === 'new'}
        onClose={() => setDialog('none')}
        onCreated={(channelId) => {
          setDialog('none');
          onSelectChannel(channelId);
          // Yeni kanal listede yok — sunucudan tazele.
          void refreshChannels();
        }}
      />
    </nav>
  );
}

function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700
                 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      <h2 className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </h2>
      <ul className="space-y-px">{children}</ul>
    </section>
  );
}

function ChannelRow({
  channel,
  isActive,
  onSelect,
}: {
  channel: ChannelSummary;
  isActive: boolean;
  onSelect: (id: Uuid) => void;
}) {
  const peer = useDirectoryStore((s) => (channel.peerUserId ? s.users[channel.peerUserId] : undefined));
  const presence = useChatStore((s) =>
    channel.peerUserId ? s.presence[channel.peerUserId]?.status : undefined,
  );

  const isDm = channel.type === ChannelType.DM;
  const label = isDm ? (peer?.displayName ?? '…') : (channel.name ?? 'Adsız kanal');
  const hasUnread = channel.unreadCount > 0 && !channel.isMuted;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(channel.id)}
        // `aria-current` ekran okuyucuya hangi kanalın açık olduğunu söyler.
        // Yalnızca renkle belirtmek görme engelli kullanıcılar için yetersizdir.
        aria-current={isActive ? 'page' : undefined}
        className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors
          ${isActive
            ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100'
            : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
      >
        {isDm ? (
          <Avatar name={label} size="sm" presence={presence ?? PresenceStatus.OFFLINE} />
        ) : (
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md
              ${isActive ? 'text-indigo-500' : 'text-slate-400'}`}
            aria-hidden="true"
          >
            <ChannelGlyph type={channel.type} />
          </span>
        )}

        <span
          className={`flex-1 truncate ${
            hasUnread ? 'font-semibold text-slate-900 dark:text-slate-50' : ''
          } ${channel.isMuted ? 'opacity-55' : ''}`}
        >
          {label}
        </span>

        {channel.isMuted && (
          <span className="shrink-0 text-slate-400" title="Bildirimler kapalı" aria-label="Bildirimler kapalı">
            <MuteIcon />
          </span>
        )}

        {hasUnread && (
          <span
            className="min-w-[20px] shrink-0 rounded-full bg-indigo-600 px-1.5 py-0.5 text-center
                       text-[11px] font-semibold leading-none text-white"
            aria-label={`${channel.unreadCount} okunmamış mesaj`}
          >
            {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
          </span>
        )}
      </button>
    </li>
  );
}

function ConnectionPill({
  state,
}: {
  state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
}) {
  const config = {
    connected: { dot: 'bg-emerald-500', text: 'Bağlı', className: 'text-slate-500' },
    connecting: { dot: 'bg-amber-500 animate-pulse', text: 'Bağlanıyor', className: 'text-amber-600' },
    reconnecting: { dot: 'bg-amber-500 animate-pulse', text: 'Yeniden bağlanıyor', className: 'text-amber-600' },
    disconnected: { dot: 'bg-rose-500', text: 'Bağlantı yok', className: 'text-rose-600' },
  }[state];

  return (
    <span className={`flex items-center gap-1.5 text-xs ${config.className}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${config.dot} motion-reduce:animate-none`}
        aria-hidden="true"
      />
      {config.text}
    </span>
  );
}

/** Yükleme sırasında düzen sıçramasını önleyen iskelet. */
function SidebarSkeleton() {
  return (
    <div className="space-y-1.5 px-1 pt-2" aria-hidden="true">
      {[68, 84, 56, 76, 62].map((width, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5">
          <div className="h-6 w-6 shrink-0 animate-pulse rounded-md bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />
          <div
            className="h-3 animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-800"
            style={{ width: `${width}%` }}
          />
        </div>
      ))}
    </div>
  );
}

// --- Simgeler ---------------------------------------------------------------
//
// Satır içi SVG kullanılır: dış font veya CDN bağımlılığı yoktur, bu yüzden
// CSP'de `font-src`/`img-src` gevşetmeye gerek kalmaz ve ilk boyama gecikmez.

function ChannelGlyph({ type }: { type: ChannelType }) {
  if (type === ChannelType.ANNOUNCEMENT) {
    return (
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
        <path d="M14 3.2a1 1 0 0 0-1.6-.8L7.3 6H4.5A2.5 2.5 0 0 0 2 8.5v1A2.5 2.5 0 0 0 4.5 12h.3l1 4a1 1 0 0 0 1 .8h1a1 1 0 0 0 1-1.2L8 12h-.7l5.1 3.6a1 1 0 0 0 1.6-.8V3.2Zm2.5 4.3a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1Z" />
      </svg>
    );
  }
  if (type === ChannelType.DEPARTMENT) {
    return (
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
        <path d="M3 3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v14H4a1 1 0 0 1-1-1V3Zm9 5h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-4V8ZM5 5h2v2H5V5Zm0 4h2v2H5V9Zm0 4h2v2H5v-2Zm9-1h2v2h-2v-2Z" />
      </svg>
    );
  }
  return <span className="text-[15px] font-medium leading-none">#</span>;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path
        fillRule="evenodd"
        d="M9 3.5a5.5 5.5 0 1 0 3.4 9.8l3.15 3.15a1 1 0 0 0 1.4-1.4l-3.14-3.15A5.5 5.5 0 0 0 9 3.5ZM5.5 9a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function MuteIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06L3.28 2.22ZM5 8v3.5l-1.5 2A.5.5 0 0 0 4 14.5h8.2L5 7.3V8Zm10 3.5V8a5 5 0 0 0-8.3-3.7l1.1 1.1A3.5 3.5 0 0 1 13.5 8v2l1.5 1.5ZM8.5 16a1.5 1.5 0 0 0 3 0h-3Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path d="M10 3a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H4a1 1 0 1 1 0-2h5V4a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M8.34 2.2a1 1 0 0 1 .98-.8h1.36a1 1 0 0 1 .98.8l.2 1a6.9 6.9 0 0 1 1.4.8l.96-.34a1 1 0 0 1 1.2.44l.68 1.18a1 1 0 0 1-.22 1.26l-.77.66a7 7 0 0 1 0 1.6l.77.66a1 1 0 0 1 .22 1.26l-.68 1.18a1 1 0 0 1-1.2.44l-.96-.34a6.9 6.9 0 0 1-1.4.8l-.2 1a1 1 0 0 1-.98.8H9.32a1 1 0 0 1-.98-.8l-.2-1a6.9 6.9 0 0 1-1.4-.8l-.96.34a1 1 0 0 1-1.2-.44l-.68-1.18a1 1 0 0 1 .22-1.26l.77-.66a7 7 0 0 1 0-1.6l-.77-.66a1 1 0 0 1-.22-1.26l.68-1.18a1 1 0 0 1 1.2-.44l.96.34a6.9 6.9 0 0 1 1.4-.8l.2-1ZM10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 1.5 3.5 4v5c0 4 2.7 7.7 6.5 9.5 3.8-1.8 6.5-5.5 6.5-9.5V4L10 1.5Zm2.9 6.4a1 1 0 0 0-1.4-1.4L9.2 8.8l-.7-.7a1 1 0 1 0-1.4 1.4l1.4 1.4a1 1 0 0 0 1.4 0l3-3Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M3 4a2 2 0 0 1 2-2h4a1 1 0 0 1 0 2H5v12h4a1 1 0 1 1 0 2H5a2 2 0 0 1-2-2V4Z" />
      <path d="M13.3 6.3a1 1 0 0 1 1.4 0l3 3a1 1 0 0 1 0 1.4l-3 3a1 1 0 0 1-1.4-1.4L14.6 11H9a1 1 0 1 1 0-2h5.6l-1.3-1.3a1 1 0 0 1 0-1.4Z" />
    </svg>
  );
}
