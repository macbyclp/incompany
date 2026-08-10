/**
 * Zengin Metin Temizleme (Sanitization).
 *
 * DEPOLAMA MODELİ: mesajlar **Markdown metni** olarak saklanır, HTML olarak
 * değil. İstemci render sırasında Markdown'ı güvenli bir ayrıştırıcıyla
 * (raw HTML kapalı) DOM'a çevirir.
 *
 * NEDEN KAYNAKTA TEMİZLİYORUZ?
 *   "Çıktıda kaçış yaparız" savunması tek istemcili sistemlerde çalışır.
 *   Burada mobil uygulama, bot API'si, e-posta özeti ve CSV dışa aktarma da
 *   aynı veriyi okur. Bunlardan biri kaçış yapmayı unuttuğunda XSS oluşur.
 *   Kaynakta temizlemek, tüketici sayısından bağımsız tek bir garanti verir.
 *
 * NE TEMİZLENMEZ
 *   Markdown sözdizimi (`**`, `` ` ``, `#`, `-`) korunur — kullanıcının
 *   yazdığı biçimlendirme kaybolmaz. Amaç metni sakatlamak değil, çalıştırılabilir
 *   içeriği ve görsel aldatmacayı ortadan kaldırmaktır.
 */

/** Aynı anda en fazla bu kadar ardışık boş satır. */
const MAX_CONSECUTIVE_NEWLINES = 3;

/**
 * Unicode iki yönlü metin (bidi) kontrol karakterleri.
 *
 * "Trojan Source" saldırısı: bu görünmez karakterler, ekranda görünen metin
 * ile gerçek bayt sırasını farklılaştırır. Bir kod incelemesinde zararsız
 * görünen bir satır, aslında bambaşka bir şey yapabilir. Sohbette de aynı
 * teknikle sahte alıntı ve yanıltıcı bağlantı üretilebilir.
 */
const BIDI_CONTROL_CHARS = /[‪-‮⁦-⁩‎‏؜]/gu;

/** Sıfır genişlikli karakterler — görünmez içerik gizleme ve DLP atlatma. */
const ZERO_WIDTH_CHARS = /[​-‍﻿⁠]/gu;

/** C0/C1 kontrol karakterleri (satır sonu, tab ve CR hariç). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** Zararlı URI şemaları — Markdown bağlantısı içinde de yakalanır. */
const DANGEROUS_SCHEMES = /\b(?:javascript|vbscript|file|jar):/giu;

/**
 * `data:` şeması yalnızca güvenli görsel tipleri için serbesttir.
 * `data:text/html` ve `data:image/svg+xml` betik çalıştırabilir.
 */
const UNSAFE_DATA_URI = /data:(?!image\/(?:png|jpe?g|gif|webp);base64,)[^\s)"']*/giu;

/** HTML etiketleri — Markdown içinde ham HTML'e izin verilmez. */
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/gu;

/** HTML varlık kodlaması ile gizlenmiş etiketler (`&lt;script&gt;`). */
const ENCODED_TAG = /&(?:lt|#0*60|#[xX]0*3[cC]);/gu;

export interface SanitizeResult {
  text: string;
  /** Hangi temizlik kurallarının tetiklendiği — denetim ve tanılama için. */
  applied: string[];
}

/**
 * Ana temizleme fonksiyonu. Sonucu ve uygulanan kuralları döner.
 * Sadece metin gerekiyorsa `sanitizeRichText` kullanın.
 */
export function sanitizeRichTextVerbose(input: string): SanitizeResult {
  const applied: string[] = [];
  let text = input;

  // 1) Unicode normalizasyonu — HER ŞEYDEN ÖNCE.
  //    Aynı karakterin farklı kodlamaları (é = U+00E9 veya e + U+0301)
  //    normalize edilmezse, sonraki desen eşleştirmeleri atlatılabilir.
  //    NFC ayrıca DLP taramasının tutarlı çalışmasını sağlar.
  const normalized = text.normalize('NFC');
  if (normalized !== text) applied.push('unicode-nfc');
  text = normalized;

  // 2) Görünmez ve kontrol karakterleri
  text = replaceAndTrack(text, CONTROL_CHARS, '', applied, 'control-chars');
  text = replaceAndTrack(text, BIDI_CONTROL_CHARS, '', applied, 'bidi-override');
  text = replaceAndTrack(text, ZERO_WIDTH_CHARS, '', applied, 'zero-width');

  // 3) Kodlanmış etiketler — ham etiketlerden ÖNCE. Sıra tersine olursa
  //    `&lt;script&gt;` çözülüp `<script>` haline gelir ve etiket temizliği
  //    çoktan çalışmış olur.
  text = replaceAndTrack(text, ENCODED_TAG, '&amp;lt;', applied, 'encoded-tag');

  // 4) Ham HTML etiketleri
  text = replaceAndTrack(text, HTML_TAG, '', applied, 'html-tag');

  // 5) Zararlı URI şemaları
  text = replaceAndTrack(text, DANGEROUS_SCHEMES, 'blocked:', applied, 'dangerous-scheme');
  text = replaceAndTrack(text, UNSAFE_DATA_URI, 'blocked:', applied, 'unsafe-data-uri');

  // 6) Aşırı boş satır — sohbet akışını bozan ve dikkat çekmek için
  //    kötüye kullanılan bir kalıptır.
  const collapsed = text.replace(/\n{4,}/gu, '\n'.repeat(MAX_CONSECUTIVE_NEWLINES));
  if (collapsed !== text) applied.push('excessive-newlines');
  text = collapsed;

  // 7) Baştaki ve sondaki boşluk. İç boşluk KORUNUR: kod blokları
  //    ve girintili listeler bozulmamalıdır.
  text = text.trim();

  return { text, applied };
}

export function sanitizeRichText(input: string): string {
  return sanitizeRichTextVerbose(input).text;
}

/**
 * Kanal adı, konu başlığı ve durum mesajı gibi TEK SATIRLIK alanlar için.
 * Markdown desteklenmez; tüm biçimlendirme düz metne indirgenir.
 */
export function sanitizePlainText(input: string, maxLength = 200): string {
  return input
    .normalize('NFC')
    .replace(CONTROL_CHARS, '')
    .replace(BIDI_CONTROL_CHARS, '')
    .replace(ZERO_WIDTH_CHARS, '')
    .replace(HTML_TAG, '')
    // Tüm boşluk türlerini tek boşluğa indir — satır sonu dahil.
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Dosya adı temizleme.
 *
 * Dizin geçişi (`../`), sürücü harfi ve ayırıcılar kaldırılır. Bir dosya adı
 * asla dosya sistemi yolu olarak yorumlanabilecek karakterler içermemelidir.
 */
export function sanitizeFileName(input: string, maxLength = 255): string {
  const cleaned = input
    .normalize('NFC')
    .replace(CONTROL_CHARS, '')
    .replace(BIDI_CONTROL_CHARS, '')
    // Yol ayırıcıları ve Windows'ta yasak karakterler
    .replace(/[/\\:*?"<>|]/gu, '_')
    // Nokta ile başlayan adlar (gizli dosya) ve `..` dizisi
    .replace(/^\.+/u, '')
    .replace(/\.{2,}/gu, '.')
    .trim();

  if (cleaned.length === 0) return 'dosya';

  // Uzantıyı koruyarak kısalt: "cok-uzun-ad.pdf" → "cok-uzun-...pdf"
  if (cleaned.length <= maxLength) return cleaned;

  const lastDot = cleaned.lastIndexOf('.');
  if (lastDot > 0 && cleaned.length - lastDot <= 10) {
    const extension = cleaned.slice(lastDot);
    return cleaned.slice(0, maxLength - extension.length) + extension;
  }
  return cleaned.slice(0, maxLength);
}

function replaceAndTrack(
  text: string,
  pattern: RegExp,
  replacement: string,
  applied: string[],
  label: string,
): string {
  // Global regex durumludur; her kullanımda sıfırlanmalıdır.
  pattern.lastIndex = 0;
  const result = text.replace(pattern, replacement);
  if (result !== text) applied.push(label);
  return result;
}
