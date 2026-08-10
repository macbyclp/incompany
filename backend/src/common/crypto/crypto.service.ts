import {
  Injectable,
  Logger,
  InternalServerErrorException,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

import { KeyManagementService } from './key-management.service';
import { ChannelKeyRepository } from './channel-key.repository';

/**
 * iNCompany — Zarf Şifreleme Servisi (AES-256-GCM)
 *
 * TEHDİT MODELİ
 *   Koruduğu: veritabanı sızıntısı, çalınmış yedek, disk imajı, meraklı DBA.
 *   KORUMADIĞI: ele geçirilmiş uygulama sunucusu. Sunucu düz metni görebiliyorsa
 *   saldırgan da görebilir. Bu senaryo yalnızca gerçek E2EE (Mod B) ile kapatılır.
 *   Bu ayrımı kullanıcıya doğru anlatmak, şifrelemenin kendisi kadar önemlidir.
 *
 * ZARF (ENVELOPE) ŞEMASI
 *   KEK (Key Encryption Key)  → Vault / AWS KMS içinde. Sürecin belleğine ASLA
 *                               düz olarak inmez; sarma/açma işlemi KMS'te olur.
 *   DEK (Data Encryption Key) → Kanal başına 256-bit. Sarmalanmış hali
 *                               `channel_keys.wrapped_dek` sütununda.
 *   Mesaj                     → AES-256-GCM ile DEK kullanılarak şifrelenir.
 *
 *   Neden zarf? KEK rotasyonu, milyonlarca mesajı yeniden şifrelemeyi değil
 *   yalnızca N adet DEK'i yeniden sarmalamayı gerektirir.
 *
 * NEDEN GCM (CBC DEĞİL)
 *   GCM bir AEAD şifrelemesidir: gizlilik + BÜTÜNLÜK birlikte gelir. CBC ile
 *   ayrıca HMAC yazmak ve doğru sırada (encrypt-then-MAC) uygulamak gerekir;
 *   bu, pratikte en sık yanlış yapılan kripto adımıdır.
 *
 * AAD İLE BAĞLAMA (context binding)
 *   AAD = "v1|{channelId}|{messageId}|{keyVersion}"
 *   Veritabanına yazma yetkisi ele geçiren bir saldırgan, A kanalındaki bir
 *   şifreli metni B kanalına kopyalayamaz — çözme işlemi AAD uyuşmazlığı
 *   nedeniyle başarısız olur. AAD olmadan GCM bu saldırıyı engellemez.
 *
 *   NEDEN messageId, seq DEĞİL? Bağlama için ikisi de eşit güçtedir, ancak
 *   `seq` yalnızca transaction içinde (kanal satırı kilitliyken) atanır.
 *   Şifrelemeyi seq'e bağlamak, olası bir KMS ağ çağrısını (~20 ms) kilit
 *   altında yapmaya zorlar ve o kanalın tüm gönderimlerini serileştirir.
 *   `messageId` transaction'dan önce üretilebildiği için kilit süresi
 *   yalnızca INSERT kadardır.
 */

/** Bir mesajın şifreli gövdesi ve çözme için gereken tüm metadata. */
export interface CipherEnvelope {
  /** Şema sürümü. Algoritma değişirse eski kayıtlar hâlâ çözülebilmelidir. */
  scheme: number;
  /** Hangi DEK sürümüyle şifrelendi — anahtar rotasyonu sonrası şart. */
  keyVersion: number;
  ciphertext: Buffer;
  /** 96-bit GCM nonce. Aynı anahtarla ASLA tekrar kullanılmaz. */
  iv: Buffer;
  /** 128-bit GCM doğrulama etiketi. */
  authTag: Buffer;
}

const SCHEME_AES_256_GCM = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bit
const IV_LENGTH = 12; // 96 bit — GCM için NIST SP 800-38D önerisi
const AUTH_TAG_LENGTH = 16; // 128 bit
const MAX_PLAINTEXT_BYTES = 64 * 1024;

/**
 * DEK önbelleği. KMS çağrısı ~20-50 ms sürer; her mesajda yapmak
 * gecikmeyi kabul edilemez hale getirir.
 *
 * TTL kısa tutulur: bir anahtar iptal edildiğinde etkisinin geçmesi için
 * beklenecek en uzun süre budur.
 */
const DEK_CACHE_TTL_MS = 5 * 60 * 1000;
const DEK_CACHE_MAX_ENTRIES = 5_000;

/**
 * NIST SP 800-38D: rastgele 96-bit IV ile aynı anahtar altında yapılabilecek
 * güvenli şifreleme sayısı ~2^32'dir (doğum günü sınırı). Bu eşiğin çok
 * altında, işletimsel olarak yönetilebilir bir noktada rotasyon tetiklenir.
 */
const KEY_ROTATION_THRESHOLD = 100_000_000;

interface CachedDek {
  key: Buffer;
  version: number;
  expiresAt: number;
}

/** Kripto hataları asla iç ayrıntı sızdırmaz — çağıran taraf yalnızca bunu görür. */
export class DecryptionFailedError extends Error {
  constructor(readonly channelId: string) {
    super('Mesaj cozulemedi');
    this.name = 'DecryptionFailedError';
  }
}

@Injectable()
export class CryptoService implements OnModuleDestroy {
  private readonly logger = new Logger(CryptoService.name);
  private readonly dekCache = new Map<string, CachedDek>();
  private readonly encryptionCounters = new Map<string, number>();

  /**
   * Uçuştaki anahtar açma işlemleri (single-flight).
   *
   * Bu olmadan, soğuk önbellekte aynı kanala eşzamanlı N gönderim N ayrı
   * KMS çağrısı yapar ve N ayrı anahtar nesnesi üretir. Yalnızca sonuncusu
   * önbelleğe kalır; diğerleri, önbelleği devraldığında geçersiz kılınan
   * nesnelerle şifreleme yapar. Sonuç: çözülemeyen mesaj = kalıcı veri kaybı.
   *
   * Tek uçuş garantisi, tüm eşzamanlı çağrıların AYNI anahtar nesnesini
   * paylaşmasını sağlar ve yarışı kökünden ortadan kaldırır.
   */
  private readonly inflightUnwraps = new Map<string, Promise<CachedDek>>();

  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly kms: KeyManagementService,
    private readonly channelKeys: ChannelKeyRepository,
  ) {
    // Süresi dolmuş anahtarları bellekten temizle ve baytlarını sıfırla.
    this.sweepTimer = setInterval(() => this.sweepCache(), 60_000);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const entry of this.dekCache.values()) entry.key.fill(0);
    this.dekCache.clear();
  }

  // -------------------------------------------------------------------------
  //  Genel API
  // -------------------------------------------------------------------------

  /**
   * Bir kanal mesajını şifreler.
   *
   * @param messageId Sunucu tarafında üretilmiş mesaj UUID'si. AAD'ye dahil
   *                  edilir; transaction'dan ÖNCE üretilmiş olmalıdır.
   */
  async encryptMessage(
    channelId: string,
    messageId: string,
    plaintext: string,
  ): Promise<CipherEnvelope> {
    const plainBuffer = Buffer.from(plaintext, 'utf8');

    if (plainBuffer.byteLength > MAX_PLAINTEXT_BYTES) {
      plainBuffer.fill(0);
      throw new InternalServerErrorException(
        `Mesaj govdesi cok buyuk: ${plainBuffer.byteLength} > ${MAX_PLAINTEXT_BYTES}`,
      );
    }

    const dek = await this.resolveActiveDek(channelId);
    const iv = randomBytes(IV_LENGTH);

    try {
      const cipher = createCipheriv(ALGORITHM, dek.key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      }) as CipherGCM;

      cipher.setAAD(this.buildAad(channelId, messageId, dek.version));

      const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
      const authTag = cipher.getAuthTag();

      this.trackUsage(channelId);

      return {
        scheme: SCHEME_AES_256_GCM,
        keyVersion: dek.version,
        ciphertext,
        iv,
        authTag,
      };
    } catch (error) {
      // Hata mesajı anahtar materyali içerebilir — asla olduğu gibi yayılmaz.
      this.logger.error(
        { channelId, messageId, err: (error as Error).name },
        'Sifreleme basarisiz',
      );
      throw new InternalServerErrorException('Mesaj sifrelenemedi');
    } finally {
      // Düz metni bellekten en kısa sürede sil (best-effort: V8 kopya tutabilir).
      plainBuffer.fill(0);
    }
  }

  /**
   * Şifreli bir mesajı çözer.
   *
   * GCM'de doğrulama etiketi tutmazsa `final()` istisna atar — bu, kurcalanmış
   * veya yanlış kanaldan gelen bir şifreli metnin sessizce çözülmesini engeller.
   */
  async decryptMessage(
    channelId: string,
    messageId: string,
    envelope: CipherEnvelope,
  ): Promise<string> {
    if (envelope.scheme !== SCHEME_AES_256_GCM) {
      throw new InternalServerErrorException(
        `Desteklenmeyen sifreleme semasi: ${envelope.scheme}`,
      );
    }
    if (envelope.iv.byteLength !== IV_LENGTH || envelope.authTag.byteLength !== AUTH_TAG_LENGTH) {
      throw new DecryptionFailedError(channelId);
    }

    // Rotasyon sonrası eski mesajlar eski DEK sürümüyle çözülmelidir.
    const dek = await this.resolveDekByVersion(channelId, envelope.keyVersion);

    try {
      const decipher = createDecipheriv(ALGORITHM, dek.key, envelope.iv, {
        authTagLength: AUTH_TAG_LENGTH,
      }) as DecipherGCM;

      decipher.setAAD(this.buildAad(channelId, messageId, envelope.keyVersion));
      decipher.setAuthTag(envelope.authTag);

      const plain = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
      const text = plain.toString('utf8');
      plain.fill(0);
      return text;
    } catch {
      // Etiket uyuşmazlığı = kurcalama, yanlış anahtar veya AAD uyuşmazlığı.
      // Ayrımı çağırana SÖYLEMEYİN: bu, oracle saldırısına zemin hazırlar.
      this.logger.warn(
        { channelId, messageId, keyVersion: envelope.keyVersion },
        'Cozme dogrulamasi basarisiz — kurcalama veya anahtar uyusmazligi',
      );
      throw new DecryptionFailedError(channelId);
    }
  }

  /** Birden çok mesajı paralel çözer; tek bir bozuk kayıt tüm sayfayı düşürmez. */
  async decryptBatch(
    channelId: string,
    items: ReadonlyArray<{ messageId: string; envelope: CipherEnvelope }>,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    const settled = await Promise.allSettled(
      items.map(async (item) => ({
        messageId: item.messageId,
        text: await this.decryptMessage(channelId, item.messageId, item.envelope),
      })),
    );

    for (let i = 0; i < settled.length; i += 1) {
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        results.set(outcome.value.messageId, outcome.value.text);
      } else {
        // Tek bir bozuk mesaj yüzünden kullanıcı tüm sohbeti kaybetmemeli.
        results.set(items[i].messageId, '[Bu mesaj cozulemedi]');
      }
    }

    return results;
  }

  /**
   * Kanal anahtarını döndürür (rotasyon).
   *
   * Eski DEK SİLİNMEZ, yalnızca pasifleştirilir: onunla şifrelenmiş geçmiş
   * mesajların çözülebilmesi gerekir. Eski anahtarın silinmesi, o dönemin
   * mesajlarının kalıcı kaybı demektir — bu bilinçli bir "crypto-shredding"
   * kararıysa ayrı bir API ile yapılmalıdır.
   */
  async rotateChannelKey(channelId: string): Promise<number> {
    const newDek = randomBytes(KEY_LENGTH);
    try {
      const wrapped = await this.kms.wrapKey(newDek);
      const version = await this.channelKeys.insertNewVersion(channelId, wrapped);

      this.evict(channelId);
      this.encryptionCounters.delete(channelId);

      this.logger.log({ channelId, version }, 'Kanal anahtari donduruldu');
      return version;
    } finally {
      newDek.fill(0);
    }
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  /**
   * AAD, şifreli metni bağlamına bağlar.
   * Sürüm öneki ("v1"), ileride AAD şeması değişirse eski kayıtların hâlâ
   * çözülebilmesini sağlar.
   */
  private buildAad(channelId: string, messageId: string, keyVersion: number): Buffer {
    return Buffer.from(`v1|${channelId}|${messageId}|${keyVersion}`, 'utf8');
  }

  private async resolveActiveDek(channelId: string): Promise<CachedDek> {
    const cached = this.dekCache.get(channelId);
    if (cached && cached.expiresAt > Date.now()) return cached;

    // Aynı kanal için bir açma işlemi zaten sürüyorsa ona katıl —
    // ikinci bir KMS çağrısı ve ikinci bir anahtar nesnesi üretme.
    const inflight = this.inflightUnwraps.get(channelId);
    if (inflight) return inflight;

    const promise = (async (): Promise<CachedDek> => {
      const record = await this.channelKeys.findActive(channelId);
      if (!record) {
        // Kanal oluşturulurken anahtar üretilmemiş — veri bütünlüğü hatası.
        throw new InternalServerErrorException(
          `Kanal icin aktif sifreleme anahtari yok: ${channelId}`,
        );
      }
      return this.unwrapAndCache(channelId, record.wrappedDek, record.version, true);
    })();

    this.inflightUnwraps.set(channelId, promise);

    try {
      return await promise;
    } finally {
      // Başarı da hata da olsa kaydı temizle; aksi halde başarısız bir
      // açma işlemi o kanalı kalıcı olarak bozuk bir promise'e kilitler.
      this.inflightUnwraps.delete(channelId);
    }
  }

  private async resolveDekByVersion(channelId: string, version: number): Promise<CachedDek> {
    const cached = this.dekCache.get(channelId);
    if (cached && cached.version === version && cached.expiresAt > Date.now()) {
      return cached;
    }

    const record = await this.channelKeys.findByVersion(channelId, version);
    if (!record) {
      this.logger.error({ channelId, version }, 'Sifreleme anahtar surumu bulunamadi');
      throw new DecryptionFailedError(channelId);
    }

    // Eski sürümler önbelleğe YAZILMAZ: aktif anahtarı yerinden ederek
    // sıcak yolu yavaşlatırlar (geçmişe kaydırma sırasında sürekli takas).
    const isActiveVersion = cached?.version === version;
    return this.unwrapAndCache(channelId, record.wrappedDek, version, isActiveVersion);
  }

  private async unwrapAndCache(
    channelId: string,
    wrapped: Buffer,
    version: number,
    cacheIt: boolean,
  ): Promise<CachedDek> {
    let key: Buffer;
    try {
      key = await this.kms.unwrapKey(wrapped);
    } catch (error) {
      this.logger.error(
        { channelId, version, err: (error as Error).message },
        'KMS anahtar acma basarisiz',
      );
      throw new InternalServerErrorException('Anahtar yonetim servisi erisilemez');
    }

    if (key.byteLength !== KEY_LENGTH) {
      key.fill(0);
      throw new InternalServerErrorException(
        `Gecersiz DEK uzunlugu: ${key.byteLength} (beklenen ${KEY_LENGTH})`,
      );
    }

    const entry: CachedDek = { key, version, expiresAt: Date.now() + DEK_CACHE_TTL_MS };

    if (cacheIt) {
      if (this.dekCache.size >= DEK_CACHE_MAX_ENTRIES) this.evictOldest();
      // Yerinden edilen girişin tamponu SIFIRLANMAZ — bkz. `evict()`.
      this.dekCache.set(channelId, entry);
    }

    return entry;
  }

  /** Rotasyon eşiğine yaklaşan kanalları uyarır (IV tekrar kullanım riski). */
  private trackUsage(channelId: string): void {
    const count = (this.encryptionCounters.get(channelId) ?? 0) + 1;
    this.encryptionCounters.set(channelId, count);

    if (count % 1_000_000 === 0 && count >= KEY_ROTATION_THRESHOLD) {
      this.logger.warn(
        { channelId, count },
        'Kanal anahtari rotasyon esigini asti — rotasyon zamanlanmali',
      );
    }
  }

  /**
   * Önbellekten çıkarır — anahtar tamponunu SIFIRLAMADAN.
   *
   * NEDEN SIFIRLAMIYORUZ?
   *   JavaScript'te bir Buffer'a kaç referans kaldığını öğrenmenin yolu
   *   yoktur. Önbellekten çıkarılan bir anahtar, o anda şifreleme yapan
   *   eşzamanlı bir çağrı tarafından hâlâ tutuluyor olabilir. Tamponu
   *   sıfırlamak, o çağrının SIFIRLARLA şifreleme yapmasına ve mesajın
   *   kalıcı olarak okunamaz hale gelmesine yol açar.
   *
   *   Bu, teoriden ibaret değil: bu davranış `decryptBatch` testiyle
   *   yakalandı (eşzamanlı `Promise.all` şifrelemesi).
   *
   * TAKAS: bellek hijyeni ↔ veri bütünlüğü.
   *   Anahtar, çöp toplayıcı onu geri alana kadar bellekte kalır. Bu bir
   *   miktar maruziyet penceresi yaratır — ama bir bellek dökümünü okuyabilen
   *   saldırgan zaten aktif önbellekteki anahtarları da okuyabilir. Kazancı
   *   sıfıra yakın, bedeli veri kaybı olan bir önlemdi.
   *
   *   Süreç kapanışında (`onModuleDestroy`) sıfırlama yapılır: orada
   *   uçuşta iş kalmadığı garanti edilir.
   */
  private evict(channelId: string): void {
    this.dekCache.delete(channelId);
  }

  private evictOldest(): void {
    const oldest = this.dekCache.keys().next();
    if (!oldest.done) this.evict(oldest.value);
  }

  private sweepCache(): void {
    const now = Date.now();
    for (const [channelId, entry] of this.dekCache) {
      if (entry.expiresAt <= now) this.evict(channelId);
    }
  }

  // -------------------------------------------------------------------------
  //  Anahtar dışı yardımcılar
  // -------------------------------------------------------------------------

  /**
   * Sabit zamanlı karşılaştırma. Webhook imzası, davet kodu, API anahtarı
   * doğrulamasında `===` KULLANILMAZ: erken çıkış yapan karşılaştırma,
   * zamanlama üzerinden sızıntı yaratır.
   */
  static safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    // Farklı uzunluklarda timingSafeEqual istisna atar; uzunluk zaten gizli değil.
    if (bufA.byteLength !== bufB.byteLength) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
