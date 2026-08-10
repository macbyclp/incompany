import { ChannelType } from '@incompany/contracts';

/**
 * Kanal Başlığı.
 *
 * NEDEN GEREKLİ? Başlıksız bir sohbet penceresinde kullanıcı hangi kanalda
 * olduğunu yalnızca kenar çubuğundaki vurgudan anlar. Kanal değiştirdiğinde
 * bağlam kaybı yaşar ve yanlış kanala mesaj gönderme riski doğar — kurumsal
 * bir üründe bu, "duyurular" kanalına özel mesaj göndermek demektir.
 *
 * Rozetler bilgilendirme değil UYARIDIR: E2EE ve duyuru kanalları farklı
 * davranır, kullanıcı bunu YAZMADAN ÖNCE bilmelidir.
 */

interface ChannelHeaderProps {
  type: ChannelType;
  name: string;
  topic?: string | null;
  memberCount?: number;
  isE2ee?: boolean;
  isReadOnly?: boolean;
  onMembersClick?: () => void;
}

export function ChannelHeader({
  type,
  name,
  topic,
  memberCount,
  isE2ee,
  isReadOnly,
  onMembersClick,
}: ChannelHeaderProps) {
  const prefix = type === ChannelType.DM ? '' : type === ChannelType.ANNOUNCEMENT ? '📢 ' : '# ';

  return (
    <header
      className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-5 py-2.5
                 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-[15px] font-semibold text-slate-900 dark:text-slate-100">
            {prefix}
            {name}
          </h1>

          {isReadOnly && (
            <Badge tone="amber" title="Bu kanala yalnızca yetkili kullanıcılar mesaj gönderebilir">
              Salt okunur
            </Badge>
          )}

          {isE2ee && (
            <Badge tone="emerald" title="Uçtan uca şifreli — sunucu içeriği göremez, arama ve arşivleme çalışmaz">
              🔒 E2EE
            </Badge>
          )}
        </div>

        {topic && (
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{topic}</p>
        )}
      </div>

      {memberCount !== undefined && (
        // DM'lerde `onMembersClick` verilmez — iki kişilik bir sohbette
        // "üyeler" paneli anlamsızdır, buton yalnızca bilgi rozeti olur.
        onMembersClick ? (
          <button
            type="button"
            onClick={onMembersClick}
            title="Üyeleri görüntüle"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1
                       text-xs text-slate-600 hover:bg-slate-50
                       dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <MemberIcon />
            {memberCount}
          </button>
        ) : (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1
                       text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"
            title={`${memberCount} üye`}
          >
            <MemberIcon />
            {memberCount}
          </span>
        )
      )}
    </header>
  );
}

function MemberIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-7 8a7 7 0 0 1 14 0H3Z" />
    </svg>
  );
}

function Badge({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: 'amber' | 'emerald';
  title: string;
}) {
  const tones = {
    amber: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
    emerald: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  };

  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}
      title={title}
    >
      {children}
    </span>
  );
}
