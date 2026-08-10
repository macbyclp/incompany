import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DatabaseService } from './database/database.service';
import { RedisService } from './redis/redis.service';
import { RateLimiterService } from './rate-limit/rate-limiter.service';
import { CryptoService } from './crypto/crypto.service';
import { ChannelKeyRepository } from './crypto/channel-key.repository';
import { KeyManagementService, LocalKmsProvider, AwsKmsProvider } from './crypto/key-management.service';

/**
 * Ortak Altyapı Modülü.
 *
 * `@Global()` bilinçli bir tercihtir: DatabaseService ve RedisService
 * neredeyse her modülde gereklidir ve her birine tek tek import etmek,
 * hiçbir mimari fayda sağlamayan bir tekrar üretir.
 *
 * İŞ MANTIĞI SERVİSLERİ BURAYA KONMAZ. Global olan yalnızca altyapıdır;
 * `ChatService` veya `ChannelPolicyService` global yapılırsa modül sınırları
 * anlamını yitirir ve mikroservise ayırma yolu kapanır.
 */
@Global()
@Module({
  providers: [
    DatabaseService,
    RedisService,
    RateLimiterService,
    CryptoService,
    ChannelKeyRepository,
    {
      /**
       * KMS sağlayıcısı ortama göre seçilir.
       *
       * `LocalKmsProvider` kendi `onModuleInit`'inde üretim ortamında
       * başlatmayı reddeder — burada bir yapılandırma hatası olsa bile
       * uygulama yerel anahtarla üretime çıkamaz.
       */
      provide: KeyManagementService,
      useFactory: (config: ConfigService): KeyManagementService => {
        const provider = config.get<string>('KMS_PROVIDER') ?? 'local';

        switch (provider) {
          case 'aws':
            return new AwsKmsProvider(config);
          case 'local':
            return new LocalKmsProvider(config);
          default:
            throw new Error(
              `Bilinmeyen KMS_PROVIDER: '${provider}'. Gecerli degerler: 'aws', 'local'`,
            );
        }
      },
      inject: [ConfigService],
    },
  ],
  exports: [
    DatabaseService,
    RedisService,
    RateLimiterService,
    CryptoService,
    ChannelKeyRepository,
    KeyManagementService,
  ],
})
export class CommonModule {}
