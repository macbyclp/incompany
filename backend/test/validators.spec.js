"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const validators_1 = require("../src/dlp/validators");
const sanitize_1 = require("../src/chat/sanitize");
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
(0, vitest_1.describe)('TCKN doğrulayıcı', () => {
    (0, vitest_1.it)('geçerli numaraları kabul eder', () => {
        // NVİ algoritmasına uygun üretilmiş test değerleri (gerçek kişi değil).
        (0, vitest_1.expect)(validators_1.validators.tckn('10000000146')).toBe(true);
        (0, vitest_1.expect)(validators_1.validators.tckn('12345678950')).toBe(true);
    });
    (0, vitest_1.it)('sağlama toplamı tutmayan numaraları reddeder', () => {
        // Bu, DLP'nin kullanılabilir olmasını sağlayan asıl kontroldür:
        // rastgele 11 haneli bir sipariş numarası engellenmemelidir.
        (0, vitest_1.expect)(validators_1.validators.tckn('12345678901')).toBe(false);
        (0, vitest_1.expect)(validators_1.validators.tckn('98765432109')).toBe(false);
    });
    (0, vitest_1.it)('0 ile başlayan numaraları reddeder', () => {
        (0, vitest_1.expect)(validators_1.validators.tckn('01234567890')).toBe(false);
    });
    (0, vitest_1.it)('tüm haneleri aynı olan numaraları reddeder', () => {
        // 11111111111 algoritmayı geçer ama gerçek bir kimlik numarası değildir.
        (0, vitest_1.expect)(validators_1.validators.tckn('11111111111')).toBe(false);
        (0, vitest_1.expect)(validators_1.validators.tckn('22222222222')).toBe(false);
    });
    (0, vitest_1.it)('yanlış uzunluktaki girdileri reddeder', () => {
        (0, vitest_1.expect)(validators_1.validators.tckn('1234567890')).toBe(false);
        (0, vitest_1.expect)(validators_1.validators.tckn('123456789012')).toBe(false);
        (0, vitest_1.expect)(validators_1.validators.tckn('')).toBe(false);
    });
    (0, vitest_1.it)('ayraçları yok sayar', () => {
        (0, vitest_1.expect)(validators_1.validators.tckn('100 000 001 46')).toBe(validators_1.validators.tckn('10000000146'));
    });
});
(0, vitest_1.describe)('Luhn doğrulayıcı', () => {
    (0, vitest_1.it)('geçerli test kartlarını kabul eder', () => {
        (0, vitest_1.expect)(validators_1.validators.luhn('4532015112830366')).toBe(true); // Visa test
        (0, vitest_1.expect)(validators_1.validators.luhn('5425233430109903')).toBe(true); // Mastercard test
        (0, vitest_1.expect)(validators_1.validators.luhn('374245455400126')).toBe(true); // Amex test (15 hane)
    });
    (0, vitest_1.it)('ayraçlı biçimleri kabul eder', () => {
        (0, vitest_1.expect)(validators_1.validators.luhn('4532 0151 1283 0366')).toBe(true);
        (0, vitest_1.expect)(validators_1.validators.luhn('4532-0151-1283-0366')).toBe(true);
    });
    (0, vitest_1.it)('sağlama toplamı tutmayan numaraları reddeder', () => {
        (0, vitest_1.expect)(validators_1.validators.luhn('4532015112830367')).toBe(false);
        (0, vitest_1.expect)(validators_1.validators.luhn('1234567812345678')).toBe(false);
    });
    (0, vitest_1.it)('tekrarlayan haneli test verisini reddeder', () => {
        (0, vitest_1.expect)(validators_1.validators.luhn('4444444444444444')).toBe(false);
    });
    (0, vitest_1.it)('uzunluk sınırlarını uygular', () => {
        (0, vitest_1.expect)(validators_1.validators.luhn('453201511283')).toBe(false); // 12 hane, çok kısa
        (0, vitest_1.expect)(validators_1.validators.luhn('45320151128303661234')).toBe(false); // 20 hane, çok uzun
    });
});
(0, vitest_1.describe)('IBAN doğrulayıcı', () => {
    (0, vitest_1.it)('geçerli TR IBAN kabul eder', () => {
        (0, vitest_1.expect)(validators_1.validators.iban('TR330006100519786457841326')).toBe(true);
    });
    (0, vitest_1.it)('boşluklu biçimi kabul eder', () => {
        (0, vitest_1.expect)(validators_1.validators.iban('TR33 0006 1005 1978 6457 8413 26')).toBe(true);
    });
    (0, vitest_1.it)('mod-97 sağlaması tutmayan IBAN reddeder', () => {
        (0, vitest_1.expect)(validators_1.validators.iban('TR330006100519786457841327')).toBe(false);
    });
    (0, vitest_1.it)('yanlış uzunluktaki TR IBAN reddeder', () => {
        // TR IBAN tam olarak 26 karakterdir.
        (0, vitest_1.expect)(validators_1.validators.iban('TR3300061005197864578413')).toBe(false);
    });
    (0, vitest_1.it)('büyük sayılarda hassasiyet kaybetmez', () => {
        // Parça parça mod alınmazsa Number taşması sessizce yanlış sonuç verir.
        (0, vitest_1.expect)(validators_1.validators.iban('DE89370400440532013000')).toBe(true);
        (0, vitest_1.expect)(validators_1.validators.iban('GB82WEST12345698765432')).toBe(true);
    });
});
(0, vitest_1.describe)('sanitizeRichText', () => {
    (0, vitest_1.it)('Markdown sözdizimini korur', () => {
        const input = '**kalin** ve `kod` ve\n- liste';
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)(input)).toBe(input);
    });
    (0, vitest_1.it)('HTML etiketlerini kaldırır', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)('merhaba <script>alert(1)</script> dunya'))
            .toBe('merhaba alert(1) dunya');
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)('<img src=x onerror=alert(1)>')).toBe('');
    });
    (0, vitest_1.it)('kodlanmış etiketleri nötrleştirir', () => {
        // Çift kodlama ile etiket temizliğini atlatma denemesi.
        const result = (0, sanitize_1.sanitizeRichText)('&lt;script&gt;alert(1)&lt;/script&gt;');
        (0, vitest_1.expect)(result).not.toContain('<script>');
        (0, vitest_1.expect)(result).toContain('&amp;lt;');
    });
    (0, vitest_1.it)('zararlı URI şemalarını engeller', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)('[tikla](javascript:alert(1))')).toContain('blocked:');
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)('[tikla](vbscript:msgbox)')).toContain('blocked:');
    });
    (0, vitest_1.it)('güvenli data URI görsellerine izin verir', () => {
        const safe = '![resim](data:image/png;base64,iVBORw0KGgo=)';
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)(safe)).toContain('data:image/png;base64');
    });
    (0, vitest_1.it)('güvensiz data URI engeller', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)('[x](data:text/html,<script>alert(1)</script>)'))
            .toContain('blocked:');
    });
    (0, vitest_1.it)('bidi kontrol karakterlerini kaldırır (Trojan Source)', () => {
        // Bu karakterler ekranda görünmez ama metnin görünen sırasını değiştirir.
        const attack = 'onayla\u202Elat\u202Cpi';
        const result = (0, sanitize_1.sanitizeRichText)(attack);
        (0, vitest_1.expect)(result).not.toContain('\u202E');
        (0, vitest_1.expect)(result).not.toContain('\u202C');
    });
    (0, vitest_1.it)('sıfır genişlikli karakterleri kaldırır', () => {
        // DLP atlatma tekniği: "TC\u200BKN" desen eşleşmesini bozar.
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)('123\u200B456')).toBe('123456');
    });
    (0, vitest_1.it)('Unicode NFC normalizasyonu uygular', () => {
        const decomposed = 'e\u0301'; // e + birleşik aksan
        const composed = '\u00e9'; // é
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)(decomposed)).toBe(composed);
    });
    (0, vitest_1.it)('aşırı boş satırları sıkıştırır', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)('a\n\n\n\n\n\n\nb')).toBe('a\n\n\nb');
    });
    (0, vitest_1.it)('kod bloğu içindeki girintiyi korur', () => {
        const code = '```\n  girintili\n    daha derin\n```';
        (0, vitest_1.expect)((0, sanitize_1.sanitizeRichText)(code)).toBe(code);
    });
});
(0, vitest_1.describe)('sanitizePlainText', () => {
    (0, vitest_1.it)('satır sonlarını tek boşluğa indirir', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizePlainText)('birinci\nikinci\n\nucuncu')).toBe('birinci ikinci ucuncu');
    });
    (0, vitest_1.it)('uzunluk sınırını uygular', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizePlainText)('a'.repeat(500), 100)).toHaveLength(100);
    });
});
(0, vitest_1.describe)('sanitizeFileName', () => {
    (0, vitest_1.it)('dizin geçişini engeller', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizeFileName)('../../etc/passwd')).not.toContain('..');
        (0, vitest_1.expect)((0, sanitize_1.sanitizeFileName)('../../etc/passwd')).not.toContain('/');
    });
    (0, vitest_1.it)('Windows yasak karakterlerini değiştirir', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizeFileName)('rapor:2026?.pdf')).toBe('rapor_2026_.pdf');
    });
    (0, vitest_1.it)('ters eğik çizgiyi temizler', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizeFileName)('C:\\Windows\\system32\\cmd.exe')).not.toContain('\\');
    });
    (0, vitest_1.it)('gizli dosya adlarını normalleştirir', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizeFileName)('.bashrc')).toBe('bashrc');
    });
    (0, vitest_1.it)('uzun adları kısaltırken uzantıyı korur', () => {
        const result = (0, sanitize_1.sanitizeFileName)(`${'a'.repeat(300)}.pdf`, 50);
        (0, vitest_1.expect)(result).toHaveLength(50);
        (0, vitest_1.expect)(result.endsWith('.pdf')).toBe(true);
    });
    (0, vitest_1.it)('tamamen geçersiz adlar için yedek değer döner', () => {
        (0, vitest_1.expect)((0, sanitize_1.sanitizeFileName)('...')).toBe('dosya');
        (0, vitest_1.expect)((0, sanitize_1.sanitizeFileName)('')).toBe('dosya');
    });
});
//# sourceMappingURL=validators.spec.js.map