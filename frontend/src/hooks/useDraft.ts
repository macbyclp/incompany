import { useState, useEffect, useCallback, useRef } from 'react';
import type { Uuid } from '@incompany/contracts';

/**
 * Kanal Bazlı Taslak Kalıcılığı.
 *
 * NEDEN GEREKLİ?
 *   Kullanıcı uzun bir mesaj yazarken başka bir kanala bakmak ister,
 *   geri döner ve yazdığı her şeyin gittiğini görür. Bu, sohbet
 *   uygulamalarında en sık şikâyet edilen kayıptır ve çözümü basittir.
 *
 * DEPOLAMA KARARI: `sessionStorage`, `localStorage` DEĞİL.
 *   Taslaklar yazılmamış mesajlardır ve hassas bilgi içerebilirler.
 *   `sessionStorage` sekme kapandığında temizlenir; `localStorage` ise
 *   ortak kullanılan bir bilgisayarda süresiz kalır. Kurumsal bir üründe
 *   bu ayrım önemlidir.
 *
 * YAZMA STRATEJİSİ: kısıtlı (debounced).
 *   Her tuş vuruşunda `sessionStorage` yazmak senkron bir disk işlemidir
 *   ve hızlı yazan bir kullanıcıda gözle görülür takılma yaratır.
 */

const STORAGE_PREFIX = 'incompany:draft:';
const DEBOUNCE_MS = 500;
const MAX_DRAFT_LENGTH = 16_000;

export function useDraft(channelId: Uuid): [string, (value: string) => void] {
  const [draft, setDraftState] = useState('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  /** Son yazılan değer — kanal değişiminde hemen kaydetmek için. */
  const latestRef = useRef('');

  const storageKey = `${STORAGE_PREFIX}${channelId}`;

  // Kanal değiştiğinde: öncekini KAYDET, yenisini YÜKLE.
  useEffect(() => {
    // Bekleyen kaydı iptal et — yeni kanalın anahtarına yazmasın.
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    try {
      const stored = sessionStorage.getItem(storageKey) ?? '';
      setDraftState(stored);
      latestRef.current = stored;
    } catch {
      // Gizli sekmede veya depolama kotası dolduğunda erişim hata verir.
      // Taslak özelliği kritik değildir; sessizce devre dışı kalır.
      setDraftState('');
      latestRef.current = '';
    }

    return () => {
      // Kanal değişiminde bekleyen taslağı HEMEN yaz — debounce'u bekleme.
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      persist(storageKey, latestRef.current);
    };
  }, [storageKey]);

  const setDraft = useCallback(
    (value: string) => {
      const clipped = value.slice(0, MAX_DRAFT_LENGTH);
      setDraftState(clipped);
      latestRef.current = clipped;

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => persist(storageKey, clipped), DEBOUNCE_MS);
    },
    [storageKey],
  );

  // Sekme kapanırken son hali yaz.
  useEffect(() => {
    const handler = (): void => persist(storageKey, latestRef.current);
    // `pagehide`, `beforeunload`'a tercih edilir: mobil tarayıcılarda ve
    // geri/ileri önbelleğinde (bfcache) güvenilir biçimde tetiklenir.
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [storageKey]);

  return [draft, setDraft];
}

function persist(key: string, value: string): void {
  try {
    if (value.trim().length === 0) {
      // Boş taslak SAKLANMAZ — depolama gereksiz anahtarlarla dolmasın.
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, value);
    }
  } catch {
    // Kota aşımı veya gizli mod. Sessizce geç.
  }
}

/** Çıkışta tüm taslakları temizler — paylaşılan bilgisayarlar için önemli. */
export function clearAllDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    // Ayrı döngüde sil: iterasyon sırasında silmek indeksleri kaydırır.
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // Sessizce geç.
  }
}
