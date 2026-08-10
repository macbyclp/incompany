import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import type { Server as SocketIOServer } from 'socket.io';

import { AppModule } from './app.module';
import { ChatGateway } from './chat/chat.gateway';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/**
 * Uygulama Başlangıcı ve Sertleştirme.
 *
 * Buradaki her satır bir saldırı yüzeyini kapatır. Sıra önemlidir:
 * güvenlik ara katmanları (middleware), iş mantığına ulaşılmadan ÖNCE çalışır.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    // Yapılandırılmış (JSON) log — SIEM'e ayrıştırılabilir şekilde akar.
    bufferLogs: true,
    // Ters proxy arkasında gerçek istemci IP'si için gereklidir.
    // Rate limit ve denetim kaydı bu IP'ye dayanır; yanlış olursa
    // tüm istekler LB'nin IP'sinden geliyormuş gibi görünür.
    rawBody: false,
  });

  const config = app.get(ConfigService);
  const isProduction = config.get('NODE_ENV') === 'production';

  // -------------------------------------------------------------------------
  //  1. Güvenlik başlıkları
  // -------------------------------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // 'unsafe-inline' ve 'unsafe-eval' YOK. Bunlar CSP'nin XSS'e karşı
          // sağladığı korumanın büyük bölümünü ortadan kaldırır.
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind runtime stilleri
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", config.get('WS_PUBLIC_URL') ?? ''],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          // Clickjacking koruması. X-Frame-Options'tan daha güçlüdür.
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: isProduction ? [] : null,
        },
      },
      // HSTS preload: tarayıcı bu alan adına ASLA HTTP ile bağlanmaz.
      hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
      // Sunucu teknolojisini gizle — sürüme özgü açık taramasını zorlaştırır.
      hidePoweredBy: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginEmbedderPolicy: false, // dosya önizlemeleri için gevşetildi
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(compression());

  // Refresh token httpOnly çerezde taşınır; bu ara katman olmadan
  // `req.cookies` tanımsız kalır ve token yenileme sessizce çalışmaz.
  //
  // İMZALI ÇEREZ KULLANILMAZ: refresh token'ın kendisi zaten imzalı bir
  // JWT'dir ve sunucuda hash'i saklanır. İkinci bir imza katmanı, korumaya
  // hiçbir şey eklemeden bir sır daha yönetmeyi gerektirirdi.
  app.use(cookieParser());

  // -------------------------------------------------------------------------
  //  2. CORS — beyaz liste, yansıtma YOK
  // -------------------------------------------------------------------------
  const allowedOrigins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (isProduction && allowedOrigins.length === 0) {
    // Yapılandırma hatasıyla üretime çıkmaktansa başlamamak daha güvenlidir.
    throw new Error('Uretimde CORS_ORIGINS tanimlanmali');
  }

  app.enableCors({
    // Gelen origin'i yansıtmak (`origin: true`) CORS'u tamamen devre dışı
    // bırakmakla eşdeğerdir — her site kimlik bilgili istek atabilir hale gelir.
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Correlation-Id'],
    maxAge: 86_400,
  });

  // -------------------------------------------------------------------------
  //  3. Girdi doğrulama
  // -------------------------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      // DTO'da tanımlı olmayan alanlar SİLİNİR.
      whitelist: true,
      // Ve varlıkları isteği REDDETTİRİR — kütle atama saldırısını kapatır.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      // Üretimde ayrıntılı doğrulama hatası dönmek, iç model yapısını sızdırır.
      disableErrorMessages: isProduction,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // API sürümleme: kırıcı değişiklikler istemcileri bir gecede bozmasın.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

  // -------------------------------------------------------------------------
  //  4. Yatay ölçeklenebilir WebSocket adapter'ı
  // -------------------------------------------------------------------------
  const redisUrl = config.getOrThrow<string>('REDIS_URL');
  const pubClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // Bağlantı koptuğunda komutları kuyruklamayı bırak: kuyruk şişerse
    // bellek tükenir ve süreç OOM ile ölür.
    enableOfflineQueue: false,
  });

  pubClient.on('error', (error) => logger.error({ err: error.message }, 'Redis hatasi'));

  // `gateway.server` (Socket.IO sunucusu), HTTP sunucusu gerçekten dinlemeye
  // BAŞLAMADAN önce `app.init()` ile kurulur — `app.listen()` bunu zaten
  // içerir ama o zamana kadar bağlantı kabul etmeye de başlar. Adapter'ı
  // trafik başlamadan önce takabilmek için önce yalnızca `init()` çağrılır.
  await app.init();
  const gateway = app.get(ChatGateway);
  // `ChatGateway`, `@WebSocketGateway({ namespace: '/ws' })` ile tanımlı —
  // bu durumda `@WebSocketServer()` kök `Server`'ı DEĞİL, o namespace'e ait
  // `Namespace` nesnesini enjekte eder. `.adapter()` yalnızca kök sunucuda
  // vardır (Namespace'de yok); `Namespace.server` bu kök sunucuya işaret
  // eden genel (public) bir alandır — socket.io'nun kendi API'sinin parçası.
  const rootServer = (gateway.server as unknown as { server: SocketIOServer }).server;
  rootServer.adapter(
    // Klasik Pub/Sub DEĞİL Streams: pub/sub ateşle-unut'tur ve bir düğüm
    // kısa süre kopsa o aralıktaki mesajları kalıcı olarak kaçırır.
    // Streams, son okunan ID'den devam eder.
    createAdapter(pubClient, {
      streamName: 'incompany:socketio',
      maxLen: 10_000,
      readCount: 100,
    }),
  );

  // -------------------------------------------------------------------------
  //  5. Düzgün kapanma (graceful shutdown)
  // -------------------------------------------------------------------------
  // Bu olmadan, dağıtım sırasında uçuştaki istekler ve açık socket'ler
  // aniden kesilir — kullanıcı her deploy'da hata görür.
  app.enableShutdownHooks();

  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`iNCompany ${isProduction ? 'uretim' : 'gelistirme'} modunda :${port} portunda`);

  // Yakalanmamış hatalarda süreç sessizce bozuk durumda devam etmemelidir.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Islenmemis promise reddi');
  });
  process.on('uncaughtException', (error) => {
    logger.error({ err: error.message, stack: error.stack }, 'Yakalanmamis istisna — kapaniliyor');
    // Bilinmeyen durumda devam etmek, veri bozulmasından daha risklidir.
    void app.close().finally(() => process.exit(1));
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Baslatma basarisiz:', error);
  process.exit(1);
});
