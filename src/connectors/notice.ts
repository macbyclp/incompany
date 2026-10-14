/**
 * Şirket botu bir gruba/kanala eklendiğinde oraya yazılan bilgilendirme. Karşı tarafın haberi olmadan
 * kayıt tutulmaması için v0.1.5'te eklendi. Hesap config'inde `notice` ile değiştirilebilir;
 * `notice: false` bildirimi kapatır (yalnız hukuken gerekmiyorsa).
 */
export const DEFAULT_GROUP_NOTICE =
  'Bilgi: Bu grup şirketin ortak hafızasına kaydediliyor. Mesajlar şirket çalışanları tarafından ' +
  'aranabilir. Kayıt dışı kalmak isteyen biri şirket yöneticisine başvurabilir.';

export function groupNotice(config: Record<string, any> | null | undefined): string | null {
  if (config?.notice === false) return null;
  const custom = typeof config?.notice === 'string' ? config.notice.trim() : '';
  return custom || DEFAULT_GROUP_NOTICE;
}
