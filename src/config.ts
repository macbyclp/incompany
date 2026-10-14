import type { Keyring } from './core/accounts.js';

/**
 * APP_SECRET (güncel anahtar) ve isteğe bağlı APP_SECRET_PREVIOUS (virgülle ayrılmış eski anahtarlar;
 * yalnız eski kayıtları okumak için, rotasyon bitince kaldırılır) ortam değişkenlerinden anahtar halkası kurar.
 */
export function loadKeyring(env: Record<string, string | undefined>): Keyring {
  const current = env.APP_SECRET;
  if (!current) throw new Error('APP_SECRET ortam değişkeni gerekli');
  const previous = (env.APP_SECRET_PREVIOUS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of [current, ...previous]) {
    if (s.length < 24) throw new Error('APP_SECRET ve APP_SECRET_PREVIOUS değerleri en az 24 karakter olmalı');
  }
  if (previous.includes(current)) throw new Error('APP_SECRET_PREVIOUS güncel anahtarı içeremez');
  return { current, previous };
}
