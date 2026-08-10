import { useMemo, useEffect } from 'react';
import type { Uuid } from '@incompany/contracts';

import { useDirectoryStore } from '../store/directory.store';

/**
 * "Yazıyor…" Göstergesi.
 *
 * SABİT YÜKSEKLİK KRİTİKTİR.
 *   Gösterge belirip kaybolduğunda yüksekliği değişirse, üstündeki mesaj
 *   listesi her seferinde sıçrar. Kullanıcı okurken bunun olması rahatsız
 *   edicidir. Alan her zaman ayrılır, yalnızca içeriği görünür/görünmez olur.
 *
 * TÜRKÇE ÇOĞUL KURALI
 *   İngilizce'deki "is/are" ayrımı Türkçe'de yoktur ama isim listeleme
 *   biçimi farklıdır: "Ali ve Ayşe yazıyor", "Ali, Ayşe ve 3 kişi daha
 *   yazıyor". Bu ayrımı doğru yapmak, arayüzün özenli hissettirmesini sağlar.
 */

interface TypingIndicatorProps {
  userIds: readonly Uuid[];
}

/** Bu sayıdan fazlası "N kişi daha" olarak özetlenir. */
const MAX_NAMES_SHOWN = 2;

export function TypingIndicator({ userIds }: TypingIndicatorProps) {
  const directory = useDirectoryStore((s) => s.users);

  // Bilinmeyen kullanıcıları dizine iste. Yazıyor sinyali, o kişinin
  // mesajından ÖNCE gelebilir — bu durumda ad henüz çözülmemiş olur ve
  // gösterge "Bir kullanıcı yazıyor…" olarak kalır.
  useEffect(() => {
    for (const id of userIds) {
      if (!directory[id]) useDirectoryStore.getState().request(id);
    }
  }, [userIds, directory]);

  const text = useMemo(() => {
    if (userIds.length === 0) return '';

    const names = userIds
      .slice(0, MAX_NAMES_SHOWN)
      .map((id) => directory[id]?.displayName ?? 'Bir kullanıcı');

    const remaining = userIds.length - names.length;

    if (remaining > 0) {
      return `${names.join(', ')} ve ${remaining} kişi daha yazıyor…`;
    }
    if (names.length === 2) {
      return `${names[0]} ve ${names[1]} yazıyor…`;
    }
    return `${names[0]} yazıyor…`;
  }, [userIds, directory]);

  return (
    // Yükseklik her zaman ayrılır — liste sıçramasın.
    <div
      className="flex h-5 shrink-0 items-center px-5 text-[12px] text-slate-500 dark:text-slate-400"
      // `aria-live="polite"`: ekran okuyucu kullanıcının o anki eylemini
      // kesmez. Yazıyor bilgisi düşük öncelikli bir bildirimdir; `assertive`
      // kullanmak, kullanıcıyı her tuş vuruşunda rahatsız eder.
      aria-live="polite"
      aria-atomic="true"
    >
      {text && (
        <span className="flex items-center gap-1.5 italic">
          <TypingDots />
          {text}
        </span>
      )}
    </div>
  );
}

/**
 * Animasyonlu üç nokta.
 *
 * `motion-reduce:animate-none`: vestibüler bozukluğu olan kullanıcılar
 * işletim sisteminde hareketi azaltma ayarını açar. Bu tercihi yok saymak,
 * bazı kullanıcılarda baş dönmesi ve mide bulantısına yol açar.
 */
function TypingDots() {
  return (
    <span className="inline-flex gap-0.5" aria-hidden="true">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1 w-1 animate-bounce rounded-full bg-slate-400 motion-reduce:animate-none"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
