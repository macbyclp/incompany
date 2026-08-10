import { describe, it, expect } from 'vitest';

import { validators } from '../src/dlp/validators';
import { sanitizeRichText, sanitizePlainText, sanitizeFileName } from '../src/chat/sanitize';

/**
 * DLP Doğrulayıcı ve Temizleyici Testleri.
 *
 * NEDEN ÖNCE BU TESTLER?
 *   Bu iki modül saf fonksiyonlardan oluşur — veritabanı, ağ veya zaman
 *   bağımlılığı yoktur. Yani hızlı, deterministik ve tam kapsamlı test
 *   edilebilirler. Aynı zamanda bir hatanın en pahalı olduğu yerlerdir:
 *   yanlış bir doğrulayıcı ya hassas veriyi kaçırır ya da kullanıcıları
 *   sistemden kaçıracak kadar yanlış pozitif üretir.
 */

describe('TCKN doğrulayıcı', () => {
  it('geçerli numaraları kabul eder', () => {
    // NVİ algoritmasına uygun üretilmiş test değerleri (gerçek kişi değil).
    expect(validators.tckn('10000000146')).toBe(true);
    expect(validators.tckn('12345678950')).toBe(true);
  });

  it('sağlama toplamı tutmayan numaraları reddeder', () => {
    // Bu, DLP'nin kullanılabilir olmasını sağlayan asıl kontroldür:
    // rastgele 11 haneli bir sipariş numarası engellenmemelidir.
    expect(validators.tckn('12345678901')).toBe(false);
    expect(validators.tckn('98765432109')).toBe(false);
  });

  it('0 ile başlayan numaraları reddeder', () => {
    expect(validators.tckn('01234567890')).toBe(false);
  });

  it('tüm haneleri aynı olan numaraları reddeder', () => {
    // 11111111111 algoritmayı geçer ama gerçek bir kimlik numarası değildir.
    expect(validators.tckn('11111111111')).toBe(false);
    expect(validators.tckn('22222222222')).toBe(false);
  });

  it('yanlış uzunluktaki girdileri reddeder', () => {
    expect(validators.tckn('1234567890')).toBe(false);
    expect(validators.tckn('123456789012')).toBe(false);
    expect(validators.tckn('')).toBe(false);
  });

  it('ayraçları yok sayar', () => {
    expect(validators.tckn('100 000 001 46')).toBe(validators.tckn('10000000146'));
  });
});

describe('Luhn doğrulayıcı', () => {
  it('geçerli test kartlarını kabul eder', () => {
    expect(validators.luhn('4532015112830366')).toBe(true); // Visa test
    expect(validators.luhn('5425233430109903')).toBe(true); // Mastercard test
    expect(validators.luhn('374245455400126')).toBe(true); // Amex test (15 hane)
  });

  it('ayraçlı biçimleri kabul eder', () => {
    expect(validators.luhn('4532 0151 1283 0366')).toBe(true);
    expect(validators.luhn('4532-0151-1283-0366')).toBe(true);
  });

  it('sağlama toplamı tutmayan numaraları reddeder', () => {
    expect(validators.luhn('4532015112830367')).toBe(false);
    expect(validators.luhn('1234567812345678')).toBe(false);
  });

  it('tekrarlayan haneli test verisini reddeder', () => {
    expect(validators.luhn('4444444444444444')).toBe(false);
  });

  it('uzunluk sınırlarını uygular', () => {
    expect(validators.luhn('453201511283')).toBe(false); // 12 hane, çok kısa
    expect(validators.luhn('45320151128303661234')).toBe(false); // 20 hane, çok uzun
  });
});

describe('IBAN doğrulayıcı', () => {
  it('geçerli TR IBAN kabul eder', () => {
    expect(validators.iban('TR330006100519786457841326')).toBe(true);
  });

  it('boşluklu biçimi kabul eder', () => {
    expect(validators.iban('TR33 0006 1005 1978 6457 8413 26')).toBe(true);
  });

  it('mod-97 sağlaması tutmayan IBAN reddeder', () => {
    expect(validators.iban('TR330006100519786457841327')).toBe(false);
  });

  it('yanlış uzunluktaki TR IBAN reddeder', () => {
    // TR IBAN tam olarak 26 karakterdir.
    expect(validators.iban('TR3300061005197864578413')).toBe(false);
  });

  it('büyük sayılarda hassasiyet kaybetmez', () => {
    // Parça parça mod alınmazsa Number taşması sessizce yanlış sonuç verir.
    expect(validators.iban('DE89370400440532013000')).toBe(true);
    expect(validators.iban('GB82WEST12345698765432')).toBe(true);
  });
});

describe('sanitizeRichText', () => {
  it('Markdown sözdizimini korur', () => {
    const input = '**kalin** ve `kod` ve\n- liste';
    expect(sanitizeRichText(input)).toBe(input);
  });

  it('HTML etiketlerini kaldırır', () => {
    expect(sanitizeRichText('merhaba <script>alert(1)</script> dunya'))
      .toBe('merhaba alert(1) dunya');
    expect(sanitizeRichText('<img src=x onerror=alert(1)>')).toBe('');
  });

  it('kodlanmış etiketleri nötrleştirir', () => {
    // Çift kodlama ile etiket temizliğini atlatma denemesi.
    const result = sanitizeRichText('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&amp;lt;');
  });

  it('zararlı URI şemalarını engeller', () => {
    expect(sanitizeRichText('[tikla](javascript:alert(1))')).toContain('blocked:');
    expect(sanitizeRichText('[tikla](vbscript:msgbox)')).toContain('blocked:');
  });

  it('güvenli data URI görsellerine izin verir', () => {
    const safe = '![resim](data:image/png;base64,iVBORw0KGgo=)';
    expect(sanitizeRichText(safe)).toContain('data:image/png;base64');
  });

  it('güvensiz data URI engeller', () => {
    expect(sanitizeRichText('[x](data:text/html,<script>alert(1)</script>)'))
      .toContain('blocked:');
  });

  it('bidi kontrol karakterlerini kaldırır (Trojan Source)', () => {
    // Bu karakterler ekranda görünmez ama metnin görünen sırasını değiştirir.
    const attack = 'onayla\u202Elat\u202Cpi';
    const result = sanitizeRichText(attack);
    expect(result).not.toContain('\u202E');
    expect(result).not.toContain('\u202C');
  });

  it('sıfır genişlikli karakterleri kaldırır', () => {
    // DLP atlatma tekniği: "TC\u200BKN" desen eşleşmesini bozar.
    expect(sanitizeRichText('123\u200B456')).toBe('123456');
  });

  it('Unicode NFC normalizasyonu uygular', () => {
    const decomposed = 'e\u0301'; // e + birleşik aksan
    const composed = '\u00e9'; // é
    expect(sanitizeRichText(decomposed)).toBe(composed);
  });

  it('aşırı boş satırları sıkıştırır', () => {
    expect(sanitizeRichText('a\n\n\n\n\n\n\nb')).toBe('a\n\n\nb');
  });

  it('kod bloğu içindeki girintiyi korur', () => {
    const code = '```\n  girintili\n    daha derin\n```';
    expect(sanitizeRichText(code)).toBe(code);
  });
});

describe('sanitizePlainText', () => {
  it('satır sonlarını tek boşluğa indirir', () => {
    expect(sanitizePlainText('birinci\nikinci\n\nucuncu')).toBe('birinci ikinci ucuncu');
  });

  it('uzunluk sınırını uygular', () => {
    expect(sanitizePlainText('a'.repeat(500), 100)).toHaveLength(100);
  });
});

describe('sanitizeFileName', () => {
  it('dizin geçişini engeller', () => {
    expect(sanitizeFileName('../../etc/passwd')).not.toContain('..');
    expect(sanitizeFileName('../../etc/passwd')).not.toContain('/');
  });

  it('Windows yasak karakterlerini değiştirir', () => {
    expect(sanitizeFileName('rapor:2026?.pdf')).toBe('rapor_2026_.pdf');
  });

  it('ters eğik çizgiyi temizler', () => {
    expect(sanitizeFileName('C:\\Windows\\system32\\cmd.exe')).not.toContain('\\');
  });

  it('gizli dosya adlarını normalleştirir', () => {
    expect(sanitizeFileName('.bashrc')).toBe('bashrc');
  });

  it('uzun adları kısaltırken uzantıyı korur', () => {
    const result = sanitizeFileName(`${'a'.repeat(300)}.pdf`, 50);
    expect(result).toHaveLength(50);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('tamamen geçersiz adlar için yedek değer döner', () => {
    expect(sanitizeFileName('...')).toBe('dosya');
    expect(sanitizeFileName('')).toBe('dosya');
  });
});
