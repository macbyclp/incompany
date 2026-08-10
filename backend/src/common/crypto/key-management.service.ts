import { Injectable, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, type CipherGCM, type DecipherGCM } from 'node:crypto';

/**
 * Anahtar Yönetim Soyutlaması (KEK katmanı).
 *
 * Uygulama kodu KEK'in nerede yaşadığını BİLMEZ. Bu soyutlama sayesinde
 * geliştirme ortamında yerel bir anahtar, üretimde AWS KMS veya Vault Transit
 * kullanılır ve iş mantığı hiç değişmez.
 *
 * ÜRETİMDE KRİTİK: Sarma/açma işlemi KMS'in İÇİNDE olmalıdır. Master anahtar
 * uygulama sürecinin belleğine düz olarak inerse, bir bellek dökümü (core dump)
 * veya SSRF ile okunan `/proc/self/mem` tüm veritabanını açar. AWS KMS ve Vault
 * Transit bu işlemi kendi sınırları içinde yapar; anahtar dışarı çıkmaz.
 */
export abstract class KeyManagementService {
  /** Düz DEK'i sarmalar. Dönen değer veritabanında saklanabilir. */
  abstract wrapKey(plaintextDek: Buffer): Promise<Buffer>;

  /** Sarmalanmış DEK'i açar. */
  abstract unwrapKey(wrappedDek: Buffer): Promise<Buffer>;

  /** Sağlık kontrolü — KMS erişilemezse uygulama trafiğe alınmamalıdır. */
  abstract healthCheck(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
//  YEREL SAĞLAYICI — YALNIZCA GELİŞTİRME VE TEST
// ---------------------------------------------------------------------------

/**
 * Master anahtarı ortam değişkeninden okur.
 *
 * ⚠ ÜRETİMDE KULLANMAYIN. Bu sınıf, KMS altyapısı olmadan yerel geliştirme
 * yapılabilmesi içindir. `NODE_ENV=production` altında başlatma reddedilir.
 */
@Injectable()
export class LocalKmsProvider extends KeyManagementService implements OnModuleInit {
  private readonly logger = new Logger(LocalKmsProvider.name);
  private masterKey!: Buffer;

  private static readonly IV_LENGTH = 12;
  private static readonly TAG_LENGTH = 16;
  private static readonly KEY_LENGTH = 32;

  constructor(private readonly config: ConfigService) {
    super();
  }

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new Error(
        'LocalKmsProvider uretimde kullanilamaz. AwsKmsProvider veya VaultKmsProvider yapilandirin.',
      );
    }

    const encoded = this.config.get<string>('LOCAL_MASTER_KEY');
    if (!encoded) {
      throw new Error(
        'LOCAL_MASTER_KEY tanimli degil. Uretmek icin: openssl rand -base64 32',
      );
    }

    const key = Buffer.from(encoded, 'base64');
    if (key.byteLength !== LocalKmsProvider.KEY_LENGTH) {
      throw new Error(
        `LOCAL_MASTER_KEY 32 bayt olmali (base64 cozulmus), bulunan: ${key.byteLength}`,
      );
    }

    this.masterKey = key;
    this.logger.warn('LocalKmsProvider aktif — YALNIZCA GELISTIRME icindir');
  }

  async wrapKey(plaintextDek: Buffer): Promise<Buffer> {
    const iv = randomBytes(LocalKmsProvider.IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv, {
      authTagLength: LocalKmsProvider.TAG_LENGTH,
    }) as CipherGCM;

    const wrapped = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
    // Depolama biçimi: [iv(12)][tag(16)][wrapped(32)]
    return Buffer.concat([iv, cipher.getAuthTag(), wrapped]);
  }

  async unwrapKey(wrappedDek: Buffer): Promise<Buffer> {
    const minLength = LocalKmsProvider.IV_LENGTH + LocalKmsProvider.TAG_LENGTH;
    if (wrappedDek.byteLength <= minLength) {
      throw new InternalServerErrorException('Bozuk sarmalanmis anahtar');
    }

    const iv = wrappedDek.subarray(0, LocalKmsProvider.IV_LENGTH);
    const tag = wrappedDek.subarray(LocalKmsProvider.IV_LENGTH, minLength);
    const payload = wrappedDek.subarray(minLength);

    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv, {
      authTagLength: LocalKmsProvider.TAG_LENGTH,
    }) as DecipherGCM;
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(payload), decipher.final()]);
  }

  async healthCheck(): Promise<boolean> {
    return this.masterKey?.byteLength === LocalKmsProvider.KEY_LENGTH;
  }
}

// ---------------------------------------------------------------------------
//  AWS KMS SAĞLAYICI — ÜRETİM
// ---------------------------------------------------------------------------

/**
 * Sarma/açma işlemleri AWS KMS içinde gerçekleşir; master anahtar bu süreçte
 * asla belleğe inmez.
 *
 * IAM politikası asgari olmalıdır: yalnızca `kms:Encrypt` ve `kms:Decrypt`.
 * `kms:ScheduleKeyDeletion` gibi izinler uygulama rolünde ASLA bulunmamalıdır —
 * ele geçirilmiş bir uygulama, tüm veriyi kalıcı olarak imha edebilir hale gelir.
 *
 * Kurulum:
 *   npm i @aws-sdk/client-kms
 */
@Injectable()
export class AwsKmsProvider extends KeyManagementService implements OnModuleInit {
  private readonly logger = new Logger(AwsKmsProvider.name);
  private client!: import('@aws-sdk/client-kms').KMSClient;
  private keyId!: string;

  constructor(private readonly config: ConfigService) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const { KMSClient } = await import('@aws-sdk/client-kms');

    this.keyId = this.config.getOrThrow<string>('AWS_KMS_KEY_ID');
    this.client = new KMSClient({
      region: this.config.getOrThrow<string>('AWS_REGION'),
      maxAttempts: 3,
    });

    // Hızlı başarısızlık: KMS erişilemezse pod hazır sayılmamalıdır.
    // Aksi halde LB trafik gönderir ve her mesaj 500 ile döner.
    if (!(await this.healthCheck())) {
      throw new Error(`AWS KMS erisilemez veya anahtar kullanilamaz: ${this.keyId}`);
    }
    this.logger.log({ keyId: this.keyId }, 'AWS KMS saglayicisi hazir');
  }

  async wrapKey(plaintextDek: Buffer): Promise<Buffer> {
    const { EncryptCommand } = await import('@aws-sdk/client-kms');

    const result = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: plaintextDek,
        // Şifreleme bağlamı, KMS tarafında AAD olarak doğrulanır:
        // bir uygulamanın ciphertext'i başka bir uygulamada çözülemez.
        EncryptionContext: { app: 'incompany', purpose: 'channel-dek' },
      }),
    );

    if (!result.CiphertextBlob) {
      throw new InternalServerErrorException('KMS bos ciphertext dondurdu');
    }
    return Buffer.from(result.CiphertextBlob);
  }

  async unwrapKey(wrappedDek: Buffer): Promise<Buffer> {
    const { DecryptCommand } = await import('@aws-sdk/client-kms');

    const result = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: wrappedDek,
        EncryptionContext: { app: 'incompany', purpose: 'channel-dek' },
      }),
    );

    if (!result.Plaintext) {
      throw new InternalServerErrorException('KMS bos plaintext dondurdu');
    }
    return Buffer.from(result.Plaintext);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const probe = randomBytes(32);
      const wrapped = await this.wrapKey(probe);
      const unwrapped = await this.unwrapKey(wrapped);
      const ok = probe.equals(unwrapped);
      probe.fill(0);
      unwrapped.fill(0);
      return ok;
    } catch (error) {
      this.logger.error({ err: (error as Error).message }, 'KMS saglik kontrolu basarisiz');
      return false;
    }
  }
}
