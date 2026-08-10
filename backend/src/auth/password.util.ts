import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Parola Karma (Hash) Yardımcıları.
 *
 * NEDEN `scrypt` — `argon2`/`bcrypt` DEĞİL?
 *   `argon2` ve `bcrypt` npm paketleri NATİF bağlayıcılardır (derlenmiş
 *   ikili gerektirir). Bu depoda daha önce iki kez platforma özgü kırılganlık
 *   bulundu (Windows CRLF sızıntısı, MSYS boru hattı kilitlenmesi) — üçüncü
 *   bir platform bağımlılığı riski (bazı Alpine/ARM/Windows kurulumlarında
 *   `node-gyp` derlemesi başarısız olabilir) kasıtlı olarak alınmadı.
 *
 *   `scrypt`, Node.js'in **çekirdek** `crypto` modülündedir — hiçbir ek
 *   bağımlılık, hiçbir derleme adımı gerektirmez ve NIST/OWASP tarafından
 *   parola karma için onaylı bir KDF'dir (bkz. OWASP Password Storage
 *   Cheat Sheet). N=16384 (2^14), r=8, p=1 parametreleri OWASP'ın önerdiği
 *   asgari çalışma faktörünü karşılar.
 *
 * FORMAT: `scrypt$<tuz-hex>$<hash-hex>`
 *   Sürüm öneki (`scrypt$`) ileride algoritma değiştirilirse eski
 *   karmaların hâlâ doğrulanabilmesini sağlar — `verifyPassword` şemayı
 *   okuyup ona göre dallanabilir.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const SCHEME = 'scrypt';

/** Yeni bir parola için karma üretir. Depolamaya hazır dizeyi döner. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `${SCHEME}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Bir parolayı saklanan karma ile karşılaştırır.
 *
 * SABİT ZAMANLI karşılaştırma kullanılır (`timingSafeEqual`). `===` veya
 * `Buffer.equals` kullanmak, karşılaştırmanın ilk farklı bayta kadar
 * geçen süresini sızdırır — bu, saldırganın karmayı bayt bayt kaba kuvvetle
 * bulmasına yol açabilecek bir zamanlama kanalıdır.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== SCHEME) return false;

  const [, saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }

  const derived = await scryptAsync(password, salt, expected.length);

  // Uzunluk farklıysa `timingSafeEqual` istisna atar; uzunluk zaten gizli
  // bir bilgi değildir (karma şemasından sabittir), bu yüzden erken dönüş
  // güvenlidir.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Parola gücü doğrulaması.
 *
 * Yalnızca UZUNLUK zorunlu kılınır — karakter sınıfı kuralları (büyük/küçük
 * harf, rakam, sembol zorunluluğu) KASITLI OLARAK YOKTUR. NIST SP 800-63B,
 * bu tür kuralların kullanıcıları öngörülebilir kalıplara ("Parola1!") ittiği
 * ve gerçek entropiyi ARTIRMADIĞI için karmaşıklık kurallarını değil uzunluğu
 * önerir. 12 karakter asgari, rastgele seçilmiş kısa bir parolayı brute-force
 * saldırısına karşı yeterince güçlü kılar.
 */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 12) return 'Parola en az 12 karakter olmalıdır';
  if (password.length > 200) return 'Parola en fazla 200 karakter olabilir';
  return null;
}
