import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { z } from 'zod';

import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { ChannelsModule } from './channels/channels.module';
import { ChatModule } from './chat/chat.module';
import { DlpModule } from './dlp/dlp.module';
import { PresenceModule } from './presence/presence.module';
import { FilesModule } from './files/files.module';
import { RetentionModule } from './retention/retention.module';
import { HealthController } from './health/health.controller';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';

/**
 * Ortam değişkeni şeması.
 *
 * NEDEN ZORUNLU DOĞRULAMA?
 *   Eksik veya hatalı bir ortam değişkeni, uygulamanın BAŞLAMASINI
 *   engellemelidir — üç saat sonra üretimde `undefined` bir JWT sırrıyla
 *   token imzalandığının fark edilmesini değil. Hatalar başlangıçta,
 *   toplu ve okunabilir biçimde raporlanır.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  REDIS_URL: z.string().url(),

  // 32 bayt minimum: HS256 için anahtar, hash çıktısından kısa olmamalıdır.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET en az 32 karakter olmali'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET en az 32 karakter olmali'),
  JWT_ISSUER: z.string().url(),
  JWT_AUDIENCE: z.string().min(1),

  KMS_PROVIDER: z.enum(['local', 'aws']).default('local'),
  LOCAL_MASTER_KEY: z.string().optional(),
  AWS_KMS_KEY_ID: z.string().optional(),
  AWS_REGION: z.string().optional(),

  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),

  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  WS_PUBLIC_URL: z.string().optional(),
  CORS_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})
  // Çapraz alan doğrulaması: seçilen KMS sağlayıcısının gerektirdiği
  // değişkenler var mı?
  .refine(
    (env) => env.KMS_PROVIDER !== 'local' || Boolean(env.LOCAL_MASTER_KEY),
    { message: "KMS_PROVIDER='local' iken LOCAL_MASTER_KEY zorunludur", path: ['LOCAL_MASTER_KEY'] },
  )
  .refine(
    (env) => env.KMS_PROVIDER !== 'aws' || (Boolean(env.AWS_KMS_KEY_ID) && Boolean(env.AWS_REGION)),
    { message: "KMS_PROVIDER='aws' iken AWS_KMS_KEY_ID ve AWS_REGION zorunludur", path: ['AWS_KMS_KEY_ID'] },
  )
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.CORS_ORIGINS.length > 0,
    { message: 'Uretimde CORS_ORIGINS tanimlanmalidir', path: ['CORS_ORIGINS'] },
  )
  .refine(
    (env) => env.JWT_ACCESS_SECRET !== env.JWT_REFRESH_SECRET,
    {
      // Aynı sır kullanılırsa bir refresh token, erişim token'ı olarak
      // kabul edilebilir hale gelir (tip karıştırma saldırısı).
      message: 'JWT_ACCESS_SECRET ve JWT_REFRESH_SECRET FARKLI olmalidir',
      path: ['JWT_REFRESH_SECRET'],
    },
  );

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => {
        const result = envSchema.safeParse(raw);
        if (!result.success) {
          const issues = result.error.issues
            .map((issue) => `  · ${issue.path.join('.')}: ${issue.message}`)
            .join('\n');
          throw new Error(`Ortam degiskeni dogrulamasi basarisiz:\n${issues}`);
        }
        return result.data;
      },
    }),

    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // Üretimde JSON (SIEM ayrıştırabilsin), geliştirmede okunabilir.
        transport:
          process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
        // Hassas başlıklar ASLA loglanmaz. Bu liste, denetim kaydının
        // ikinci bir sızıntı kaynağına dönüşmesini engeller.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.refreshToken',
            'res.headers["set-cookie"]',
          ],
          censor: '[REDACTED]',
        },
        autoLogging: {
          // Sağlık kontrolleri saniyede birkaç kez çalışır — log gürültüsü yapar.
          ignore: (req) => req.url?.startsWith('/health') ?? false,
        },
      },
    }),

    // Retention temizliği, anahtar rotasyonu, oturum budama, denetim zinciri
    // doğrulaması için planlı görevler.
    ScheduleModule.forRoot(),

    CommonModule,
    AuditModule,
    AuthModule,
    ChannelsModule,
    DlpModule,
    PresenceModule,
    ChatModule,
    FilesModule,
    RetentionModule,
  ],

  controllers: [HealthController],

  providers: [
    /**
     * GUARD SIRASI ÖNEMLİDİR — dizideki sıra, çalışma sırasıdır.
     *
     *   1. JwtAuthGuard  → "Sen kimsin?"      (kimlik doğrulama)
     *   2. RolesGuard    → "Bunu yapabilir misin?" (yetkilendirme)
     *
     * Ters sırada, RolesGuard kimlik bağlamı olmadan çalışır ve her isteği
     * reddeder. Guard'ları global bağlamak, varsayılan davranışı "kapalı"
     * yapar: yeni bir controller yazan geliştirici guard eklemeyi unutursa
     * uç nokta korumasız kalmaz — erişilemez olur.
     */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
