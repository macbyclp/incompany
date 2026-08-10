import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

import { CryptoService, DecryptionFailedError } from '../src/common/crypto/crypto.service';
import type { KeyManagementService } from '../src/common/crypto/key-management.service';
import type { ChannelKeyRepository } from '../src/common/crypto/channel-key.repository';

/**
 * Şifreleme Servisi Testleri.
 *
 * BU TESTLER NEYİ KANITLAR?
 *   Gidiş-dönüş çalışıyor mu değil — o zaten kolaydır. Asıl kanıtlanması
 *   gereken, şifrelemenin GÜVENLİK ÖZELLİKLERİDİR:
 *     · AAD bağlaması: bir kanalın şifreli metni başka kanalda çözülemez
 *     · Bütünlük: kurcalanmış şifreli metin sessizce çözülmez
 *     · IV benzersizliği: aynı düz metin farklı şifreli metinler üretir
 *     · Anahtar sürümleme: rotasyon sonrası eski mesajlar okunabilir
 *
 *   Bu özelliklerden herhangi biri kırıldığında şifreleme "çalışmaya"
 *   devam eder ama koruma sağlamaz — bu yüzden test edilmeleri şarttır.
 */

/** Test için sahte KMS: sarma/açma işlemini yerel bir anahtarla yapar. */
function createFakeKms(): KeyManagementService {
  const masterKey = randomBytes(32);

  return {
    async wrapKey(dek: Buffer): Promise<Buffer> {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
      const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), wrapped]);
    },
    async unwrapKey(wrapped: Buffer): Promise<Buffer> {
      const iv = wrapped.subarray(0, 12);
      const tag = wrapped.subarray(12, 28);
      const payload = wrapped.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(payload), decipher.final()]);
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  } as KeyManagementService;
}

/** Sahte anahtar deposu — bellekte sürüm bazlı DEK tutar. */
function createFakeKeyRepo(kms: KeyManagementService) {
  const store = new Map<string, Array<{ version: number; wrappedDek: Buffer }>>();

  return {
    async ensureChannel(channelId: string): Promise<void> {
      if (store.has(channelId)) return;
      const dek = randomBytes(32);
      store.set(channelId, [{ version: 1, wrappedDek: await kms.wrapKey(dek) }]);
    },
    async findActive(channelId: string) {
      const versions = store.get(channelId);
      if (!versions) return null;
      const latest = versions[versions.length - 1];
      return { channelId, version: latest.version, wrappedDek: latest.wrappedDek } as never;
    },
    async findByVersion(channelId: string, version: number) {
      const found = store.get(channelId)?.find((v) => v.version === version);
      return found ? ({ channelId, version, wrappedDek: found.wrappedDek } as never) : null;
    },
    async insertNewVersion(channelId: string, wrappedDek: Buffer): Promise<number> {
      const versions = store.get(channelId) ?? [];
      const nextVersion = (versions[versions.length - 1]?.version ?? 0) + 1;
      versions.push({ version: nextVersion, wrappedDek });
      store.set(channelId, versions);
      return nextVersion;
    },
  };
}

describe('CryptoService', () => {
  let service: CryptoService;
  let keyRepo: ReturnType<typeof createFakeKeyRepo>;

  const CHANNEL_A = '11111111-1111-4111-8111-111111111111';
  const CHANNEL_B = '22222222-2222-4222-8222-222222222222';
  const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';

  beforeEach(async () => {
    const kms = createFakeKms();
    keyRepo = createFakeKeyRepo(kms);
    await keyRepo.ensureChannel(CHANNEL_A);
    await keyRepo.ensureChannel(CHANNEL_B);

    service = new CryptoService(kms, keyRepo as unknown as ChannelKeyRepository);
  });

  describe('gidiş-dönüş', () => {
    it('şifreleyip çözer', async () => {
      const plaintext = 'Toplanti yarin saat 14:00, konferans salonu.';
      const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, plaintext);
      const decrypted = await service.decryptMessage(CHANNEL_A, MESSAGE_ID, envelope);

      expect(decrypted).toBe(plaintext);
    });

    it('Türkçe karakterleri ve emojiyi korur', async () => {
      const plaintext = 'Çğıöşü ÇĞİÖŞÜ — proje şubat ayında bitiyor 🚀';
      const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, plaintext);

      expect(await service.decryptMessage(CHANNEL_A, MESSAGE_ID, envelope)).toBe(plaintext);
    });

    it('boş dizeyi işler', async () => {
      const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, '');
      expect(await service.decryptMessage(CHANNEL_A, MESSAGE_ID, envelope)).toBe('');
    });

    it('64 KB sınırındaki mesajı işler', async () => {
      const large = 'a'.repeat(64 * 1024);
      const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, large);
      expect(await service.decryptMessage(CHANNEL_A, MESSAGE_ID, envelope)).toBe(large);
    });

    it('sınırı aşan mesajı reddeder', async () => {
      await expect(
        service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'a'.repeat(64 * 1024 + 1)),
      ).rejects.toThrow();
    });
  });

  describe('AAD bağlaması — bağlam değiştirme saldırısı', () => {
    it('şifreli metin BAŞKA BİR KANALDA çözülemez', async () => {
      // Bu, veritabanına yazma yetkisi olan bir saldırganın yapabileceği
      // en doğrudan saldırıdır: gizli bir kanalın şifreli metnini kendi
      // kanalına kopyalamak. AAD bunu imkânsız kılar.
      const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'gizli bilgi');

      await expect(
        service.decryptMessage(CHANNEL_B, MESSAGE_ID, envelope),
      ).rejects.toThrow(DecryptionFailedError);
    });

    it('şifreli metin BAŞKA BİR MESAJ KİMLİĞİYLE çözülemez', async () => {
      const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'gizli bilgi');
      const otherId = '44444444-4444-4444-8444-444444444444';

      await expect(
        service.decryptMessage(CHANNEL_A, otherId, envelope),
      ).rejects.toThrow(DecryptionFailedError);
    });
  });

  describe('bütünlük — kurcalama tespiti', () => {
    it('değiştirilmiş şifreli metni reddeder', async () => {
      const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'onaylandi');

      // Tek bir bit çevir. GCM'de bu, doğrulama etiketini geçersiz kılar.
      const tampered = Buffer.from(envelope.ciphertext);
      tampered[0] ^= 0x01;

      await expect(
        service.decryptMessage(CHANNEL_A, MESSAGE_ID, { ...envelope, ciphertext: tampered }),
      ).rejects.toThrow(DecryptionFailedError);
    });

    it('değiştirilmiş doğrulama etiketini reddeder', async () => {
      const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'onaylandi');
      const tamperedTag = Buffer.from(envelope.authTag);
      tamperedTag[0] ^= 0xff;

      await expect(
        service.decryptMessage(CHANNEL_A, MESSAGE_ID, { ...envelope, authTag: tamperedTag }),
      ).rejects.toThrow(DecryptionFailedError);
    });

    it('değiştirilmiş IV ile çözmeyi reddeder', async () => {
      const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'onaylandi');
      const tamperedIv = randomBytes(12);

      await expect(
        service.decryptMessage(CHANNEL_A, MESSAGE_ID, { ...envelope, iv: tamperedIv }),
      ).rejects.toThrow(DecryptionFailedError);
    });

    it('hatalı uzunluktaki IV ve etiketi reddeder', async () => {
      const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'test');

      await expect(
        service.decryptMessage(CHANNEL_A, MESSAGE_ID, { ...envelope, iv: randomBytes(16) }),
      ).rejects.toThrow(DecryptionFailedError);

      await expect(
        service.decryptMessage(CHANNEL_A, MESSAGE_ID, { ...envelope, authTag: randomBytes(8) }),
      ).rejects.toThrow(DecryptionFailedError);
    });
  });

  describe('IV benzersizliği', () => {
    it('aynı düz metin için farklı şifreli metin üretir', async () => {
      // Sabit IV kullanılsaydı, aynı mesaj aynı şifreli metni üretir ve
      // saldırgan içeriği bilmeden bile tekrarları tespit edebilirdi.
      // GCM'de sabit IV, anahtarın tamamen ele geçirilmesine bile yol açar.
      const a = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'ayni mesaj');
      const b = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'ayni mesaj');

      expect(a.iv.equals(b.iv)).toBe(false);
      expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    });

    it('100 şifrelemede IV tekrarı olmaz', async () => {
      const ivs = new Set<string>();

      for (let i = 0; i < 100; i += 1) {
        const envelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, `mesaj ${i}`);
        ivs.add(envelope.iv.toString('hex'));
      }

      expect(ivs.size).toBe(100);
    });
  });

  describe('eşzamanlılık — regresyon', () => {
    /**
     * REGRESYON: soğuk önbellekte eşzamanlı şifreleme.
     *
     * ÖNCEKİ HATA: `resolveActiveDek` tek uçuş (single-flight) garantisi
     * vermiyordu. Aynı kanala N eşzamanlı gönderim N ayrı DEK nesnesi
     * üretiyor, önbelleğe son yazan diğerlerinin tamponunu sıfırlıyordu.
     * Sıfırlanan tamponu tutan çağrılar SIFIRLARLA şifreliyor ve mesajlar
     * kalıcı olarak okunamaz hale geliyordu.
     *
     * Bu, yalnızca eşzamanlılık altında ve yalnızca önbellek soğukken
     * ortaya çıkıyordu — yani üretimde her yeniden başlatmadan sonraki
     * ilk saniyelerde ve sessizce.
     */
    it('soğuk önbellekte eşzamanlı şifreleme doğru anahtarı kullanır', async () => {
      const texts = Array.from({ length: 20 }, (_, i) => `eszamanli mesaj ${i}`);

      // Promise.all: hepsi önbellek doldurulmadan ÖNCE resolveActiveDek çağırır.
      const envelopes = await Promise.all(
        texts.map((text, index) =>
          service.encryptMessage(CHANNEL_A, `8888888${index % 10}-8888-4888-8888-888888888888`, text),
        ),
      );

      const decrypted = await Promise.all(
        envelopes.map((envelope, index) =>
          service.decryptMessage(
            CHANNEL_A,
            `8888888${index % 10}-8888-4888-8888-888888888888`,
            envelope,
          ),
        ),
      );

      expect(decrypted).toEqual(texts);
    });

    it('birden çok kanala eşzamanlı şifreleme anahtarları karıştırmaz', async () => {
      const [a, b] = await Promise.all([
        service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'kanal a mesaji'),
        service.encryptMessage(CHANNEL_B, MESSAGE_ID, 'kanal b mesaji'),
      ]);

      expect(await service.decryptMessage(CHANNEL_A, MESSAGE_ID, a)).toBe('kanal a mesaji');
      expect(await service.decryptMessage(CHANNEL_B, MESSAGE_ID, b)).toBe('kanal b mesaji');

      // Çapraz çözme başarısız olmalı — anahtarlar gerçekten ayrı.
      await expect(service.decryptMessage(CHANNEL_B, MESSAGE_ID, a)).rejects.toThrow();
    });
  });

  describe('anahtar rotasyonu', () => {
    it('rotasyondan sonra eski mesajlar hâlâ çözülebilir', async () => {
      // Bu, rotasyonun en kritik özelliğidir. Eski anahtar erişilemez
      // hale gelirse, o dönemin tüm mesajları kalıcı olarak kaybolur.
      const oldEnvelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'eski mesaj');
      expect(oldEnvelope.keyVersion).toBe(1);

      const newVersion = await service.rotateChannelKey(CHANNEL_A);
      expect(newVersion).toBe(2);

      const newEnvelope = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'yeni mesaj');
      expect(newEnvelope.keyVersion).toBe(2);

      // Her iki sürüm de çözülebilmeli.
      expect(await service.decryptMessage(CHANNEL_A, MESSAGE_ID, oldEnvelope)).toBe('eski mesaj');
      expect(await service.decryptMessage(CHANNEL_A, MESSAGE_ID, newEnvelope)).toBe('yeni mesaj');
    });

    it('kanallar bağımsız anahtar sürümleri tutar', async () => {
      await service.rotateChannelKey(CHANNEL_A);

      const a = await service.encryptMessage(CHANNEL_A, MESSAGE_ID, 'kanal a');
      const b = await service.encryptMessage(CHANNEL_B, MESSAGE_ID, 'kanal b');

      expect(a.keyVersion).toBe(2);
      expect(b.keyVersion).toBe(1);
    });
  });

  describe('toplu çözme', () => {
    it('birden çok mesajı çözer', async () => {
      const items = await Promise.all(
        ['bir', 'iki', 'uc'].map(async (text, index) => {
          const messageId = `5555555${index}-5555-4555-8555-555555555555`;
          return { messageId, envelope: await service.encryptMessage(CHANNEL_A, messageId, text) };
        }),
      );

      const results = await service.decryptBatch(CHANNEL_A, items);

      expect(results.get(items[0].messageId)).toBe('bir');
      expect(results.get(items[1].messageId)).toBe('iki');
      expect(results.get(items[2].messageId)).toBe('uc');
    });

    it('tek bozuk kayıt tüm sayfayı düşürmez', async () => {
      // Bir mesaj bozulduğunda kullanıcı tüm sohbeti kaybetmemelidir.
      const goodId = '66666666-6666-4666-8666-666666666666';
      const badId = '77777777-7777-4777-8777-777777777777';

      const good = await service.encryptMessage(CHANNEL_A, goodId, 'saglam mesaj');
      const bad = await service.encryptMessage(CHANNEL_A, badId, 'bozuk mesaj');
      const corrupted = Buffer.from(bad.ciphertext);
      corrupted[0] ^= 0xff;

      const results = await service.decryptBatch(CHANNEL_A, [
        { messageId: goodId, envelope: good },
        { messageId: badId, envelope: { ...bad, ciphertext: corrupted } },
      ]);

      expect(results.get(goodId)).toBe('saglam mesaj');
      expect(results.get(badId)).toBe('[Bu mesaj cozulemedi]');
    });
  });

  describe('safeEquals', () => {
    it('eşit dizeler için true döner', () => {
      expect(CryptoService.safeEquals('gizli-token', 'gizli-token')).toBe(true);
    });

    it('farklı dizeler için false döner', () => {
      expect(CryptoService.safeEquals('gizli-token', 'gizli-tokeM')).toBe(false);
    });

    it('farklı uzunluklarda istisna atmaz', () => {
      // timingSafeEqual ham haliyle farklı uzunlukta istisna atar.
      expect(() => CryptoService.safeEquals('kisa', 'cok-daha-uzun-deger')).not.toThrow();
      expect(CryptoService.safeEquals('kisa', 'cok-daha-uzun-deger')).toBe(false);
    });
  });
});
