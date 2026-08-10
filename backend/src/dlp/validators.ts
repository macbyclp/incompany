/**
 * DLP Doğrulayıcıları — İkinci Aşama Eleme.
 *
 * Regex "buna benziyor" der, doğrulayıcı "bu gerçekten o" der.
 * Bu ayrım, DLP'nin kullanılabilir olup olmamasını belirler:
 * her 11 haneli sayıyı TCKN sanan bir motor, sipariş numarası paylaşan
 * herkesi engeller ve iki hafta içinde kapatılır.
 *
 * Tüm fonksiyonlar saf (pure) ve yan etkisizdir — birim testi doğrudan yazılabilir.
 */

export type ValidatorName = 'tckn' | 'luhn' | 'iban';

/**
 * T.C. Kimlik Numarası doğrulaması (NVİ algoritması).
 *
 * Kurallar:
 *   · 11 hane, ilk hane 0 olamaz
 *   · 10. hane = ((1,3,5,7,9. hanelerin toplamı × 7) − (2,4,6,8. hanelerin toplamı)) mod 10
 *   · 11. hane = (ilk 10 hanenin toplamı) mod 10
 *
 * Rastgele 11 haneli bir sayının bu testi geçme olasılığı ~1/100'dür;
 * yanlış pozitifleri iki kat büyüklükte azaltır.
 */
function isValidTckn(raw: string): boolean {
  const digits = raw.replace(/\D/gu, '');
  if (digits.length !== 11) return false;
  if (digits[0] === '0') return false;

  // Tüm haneleri aynı olan değerler (11111111111) algoritmayı geçebilir
  // ama gerçek kimlik numarası değildir.
  if (/^(\d)\1{10}$/u.test(digits)) return false;

  const d = Array.from(digits, Number);

  let oddSum = 0; // 1., 3., 5., 7., 9. haneler (0-indeksli: 0,2,4,6,8)
  let evenSum = 0; // 2., 4., 6., 8. haneler (0-indeksli: 1,3,5,7)
  for (let i = 0; i < 9; i += 1) {
    if (i % 2 === 0) oddSum += d[i];
    else evenSum += d[i];
  }

  // JavaScript'te % negatif sonuç verebilir; +10 ile normalize edilir.
  const check10 = ((oddSum * 7 - evenSum) % 10 + 10) % 10;
  if (check10 !== d[9]) return false;

  const first10Sum = d.slice(0, 10).reduce((sum, n) => sum + n, 0);
  return first10Sum % 10 === d[10];
}

/**
 * Luhn (mod 10) sağlama toplamı — kredi kartı, IMEI ve benzeri.
 *
 * Kart numarası olduğunu KANITLAMAZ, yalnızca sağlama toplamının tuttuğunu
 * gösterir. DLP amacı için bu yeterlidir: amaç kart doğrulamak değil,
 * kart gibi görünen veriyi engellemektir.
 */
function isValidLuhn(raw: string): boolean {
  const digits = raw.replace(/\D/gu, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/u.test(digits)) return false; // 4444444444444444 gibi test verisi

  let sum = 0;
  let double = false;

  // Sağdan sola: her ikinci hane iki ile çarpılır, 9'u aşarsa 9 çıkarılır.
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

/**
 * IBAN doğrulaması (ISO 13616, mod-97).
 *
 * Algoritma: ilk 4 karakteri sona taşı, harfleri sayıya çevir (A=10..Z=35),
 * elde edilen büyük sayının 97'ye bölümünden kalan 1 olmalıdır.
 *
 * Sayı 2^53'ü aştığı için parça parça mod alınır — `Number` ile tek seferde
 * hesaplamak sessizce yanlış sonuç verir (kayan nokta hassasiyet kaybı).
 */
function isValidIban(raw: string): boolean {
  const iban = raw.replace(/[\s-]/gu, '').toUpperCase();

  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/u.test(iban)) return false;

  // TR IBAN'ı tam olarak 26 karakterdir.
  if (iban.startsWith('TR') && iban.length !== 26) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);

  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    // A-Z → 10-35 (iki haneli), 0-9 → tek haneli
    const chunk = code >= 65 && code <= 90 ? String(code - 55) : char;

    for (const digit of chunk) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }

  return remainder === 1;
}

export const validators: Readonly<Record<ValidatorName, (value: string) => boolean>> =
  Object.freeze({
    tckn: isValidTckn,
    luhn: isValidLuhn,
    iban: isValidIban,
  });
