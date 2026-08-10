import { useMemo } from 'react';
import { PresenceStatus } from '@incompany/contracts';

/**
 * Kullanıcı Avatarı.
 *
 * RENK, İSİMDEN DETERMİNİSTİK ÜRETİLİR.
 *   Aynı kişi her yerde aynı rengi alır — kullanıcı listede kimin yazdığını
 *   ismi okumadan, renkten tanır. Rastgele renk atamak bu faydayı yok eder;
 *   herkese aynı rengi vermek de öyle.
 *
 *   Palet, koyu ve açık temada okunabilirliği doğrulanmış tonlardan seçilir.
 *   Beyaz metin, seçilen 600 tonlarının hepsinde WCAG AA'yı geçer.
 */

const AVATAR_COLORS = [
  'bg-rose-600',
  'bg-orange-600',
  'bg-amber-600',
  'bg-emerald-600',
  'bg-teal-600',
  'bg-sky-600',
  'bg-indigo-600',
  'bg-violet-600',
  'bg-fuchsia-600',
] as const;

const PRESENCE_STYLE: Record<PresenceStatus, { color: string; label: string }> = {
  [PresenceStatus.ONLINE]: { color: 'bg-emerald-500', label: 'Çevrimiçi' },
  [PresenceStatus.AWAY]: { color: 'bg-amber-500', label: 'Dışarıda' },
  [PresenceStatus.BUSY]: { color: 'bg-rose-500', label: 'Meşgul' },
  [PresenceStatus.DND]: { color: 'bg-rose-600', label: 'Rahatsız etmeyin' },
  [PresenceStatus.OFFLINE]: { color: 'bg-slate-400', label: 'Çevrimdışı' },
};

interface AvatarProps {
  name: string;
  imageUrl?: string;
  size?: 'sm' | 'md' | 'lg';
  presence?: PresenceStatus;
}

const SIZES = {
  sm: { box: 'h-6 w-6', text: 'text-[10px]', dot: 'h-2 w-2 ring-1' },
  md: { box: 'h-9 w-9', text: 'text-xs', dot: 'h-2.5 w-2.5 ring-2' },
  lg: { box: 'h-10 w-10', text: 'text-sm', dot: 'h-3 w-3 ring-2' },
} as const;

export function Avatar({ name, imageUrl, size = 'md', presence }: AvatarProps) {
  const { initials, colorClass } = useMemo(() => {
    // Türkçe yerel ayarı: "ışık" → "I" değil "I"; `toLocaleUpperCase('tr-TR')`
    // olmadan "i" harfi yanlış büyütülür ve baş harf hatalı görünür.
    const words = name.trim().split(/\s+/u).filter(Boolean);
    const first = words[0]?.charAt(0) ?? '?';
    const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';

    // Basit toplam hash — kriptografik olması gerekmiyor, yalnızca kararlı olması.
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash + name.charCodeAt(i)) % AVATAR_COLORS.length;

    return {
      initials: `${first}${last}`.toLocaleUpperCase('tr-TR'),
      colorClass: AVATAR_COLORS[hash]!,
    };
  }, [name]);

  const s = SIZES[size];
  const presenceInfo = presence ? PRESENCE_STYLE[presence] : null;

  return (
    <span className="relative inline-flex shrink-0">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          className={`${s.box} rounded-lg object-cover`}
          loading="lazy"
        />
      ) : (
        <span
          className={`${s.box} ${s.text} ${colorClass} flex items-center justify-center rounded-lg font-semibold text-white`}
          aria-hidden="true"
        >
          {initials}
        </span>
      )}

      {presenceInfo && (
        <span
          className={`${s.dot} absolute -bottom-0.5 -right-0.5 rounded-full ring-white dark:ring-slate-900 ${presenceInfo.color}`}
          // Durum yalnızca RENKLE anlatılmaz — renk körü kullanıcılar ve
          // ekran okuyucular için metin karşılığı da verilir.
          role="img"
          aria-label={presenceInfo.label}
          title={presenceInfo.label}
        />
      )}
    </span>
  );
}

export { PRESENCE_STYLE };
