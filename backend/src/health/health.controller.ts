import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';

import { Public } from '../auth/decorators';
import { DatabaseService } from '../common/database/database.service';
import { RedisService } from '../common/redis/redis.service';
import { KeyManagementService } from '../common/crypto/key-management.service';

/**
 * Sağlık Kontrolleri.
 *
 * LIVENESS ≠ READINESS — bu ayrım kritiktir:
 *
 *   /health        (liveness)  → "Süreç yaşıyor mu?" Bağımlılık KONTROL ETMEZ.
 *                                Veritabanı düştüğünde Kubernetes'in tüm
 *                                pod'ları yeniden başlatmasını istemezsiniz;
 *                                bu, sorunu çözmez ve yeniden başlatma
 *                                fırtınası yaratır.
 *
 *   /health/ready  (readiness) → "Trafik alabilir mi?" Bağımlılıkları kontrol
 *                                eder. Başarısızsa pod yeniden başlatılmaz,
 *                                yalnızca yük dengeleyiciden çıkarılır.
 *                                Bağımlılık düzelince kendiliğinden döner.
 *
 * Bu ikisini karıştırmak, kısmi bir kesintiyi tam kesintiye dönüştüren
 * en yaygın Kubernetes yapılandırma hatasıdır.
 */
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly kms: KeyManagementService,
  ) {}

  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  liveness(): { status: string; uptimeSec: number } {
    return {
      status: 'ok',
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Public()
  @Get('ready')
  async readiness(): Promise<{
    status: string;
    checks: Record<string, { ok: boolean; latencyMs?: number }>;
  }> {
    const [database, redis, kms] = await Promise.all([
      this.db.healthCheck(),
      this.redis.healthCheck(),
      // KMS kontrolü bir şifreleme/çözme turu yapar — pahalıdır ama
      // KMS erişimi olmadan hiçbir mesaj işlenemez, bu yüzden readiness'in
      // parçası olmalıdır.
      this.kms.healthCheck().then((ok) => ({ ok })),
    ]);

    const checks = { database, redis, kms };
    const allHealthy = Object.values(checks).every((check) => check.ok);

    if (!allHealthy) {
      // 503 ile yanıt ver: Kubernetes bu pod'a trafik göndermeyi durdurur.
      throw new ServiceUnavailableException({ status: 'degraded', checks });
    }

    return { status: 'ok', checks };
  }

  /**
   * İşletim metrikleri — dahili ağdan erişilebilir olmalıdır.
   * Üretimde bu uç nokta ingress'ten DIŞARI AÇILMAZ.
   */
  @Public()
  @Get('metrics')
  metrics(): Record<string, unknown> {
    const memory = process.memoryUsage();
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      memory: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      },
      // Havuzda bekleyen istek sayısı sürekli sıfırdan büyükse, havuz
      // boyutu yetersizdir veya sorgular çok uzun sürüyordur.
      dbPool: this.db.poolStats,
      nodeVersion: process.version,
    };
  }
}
