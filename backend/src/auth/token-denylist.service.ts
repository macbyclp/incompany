import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../common/redis/redis.service';
import { TOKEN_TTL } from './auth.types';

/**
 * JWT İptal Listesi.
 *
 * PROBLEM: JWT tasarımı gereği DURUMSUZDUR — yayınlandıktan sonra geri
 * alınamaz. Kurumsal bir sistemde bu kabul edilemez: bir çalışan işten
 * ayrıldığında, bir cihaz çalındığında veya bir güvenlik olayında oturum
 * ANINDA sonlanmalıdır, 15 dakika sonra değil.
 *
 * ÇÖZÜM: İki katmanlı iptal.
 *   · `jti` denylist  → tek bir token (bu cihazdan çıkış)
 *   · `token_version` → kullanıcının tüm token'ları (rol değişimi, hesap kilidi)
 *
 * MALİYET: istek başına bir Redis EXISTS (~0.3 ms). JWT'nin "veritabanına
 * gitmeme" avantajının bir kısmı feda edilir; karşılığında iptal edilebilirlik
 * kazanılır. Kurumsal bağlamda bu takas her zaman doğru yöndedir.
 *
 * BELLEK: her giriş, token'ın kalan ömrü kadar TTL alır. Token zaten süresi
 * dolduğunda reddedileceği için, denylist'te tutulmasının bir anlamı kalmaz.
 * Böylece liste sınırsız büyümez.
 */
@Injectable()
export class TokenDenylistService {
  private readonly logger = new Logger(TokenDenylistService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Bir token'ı iptal eder.
   *
   * @param expiresAt Token'ın son geçerlilik anı (epoch ms). TTL bundan
   *                  hesaplanır — süresi zaten dolmuşsa hiç yazılmaz.
   */
  async revoke(jti: string, expiresAt: number, reason: string): Promise<void> {
    const ttlSeconds = Math.ceil((expiresAt - Date.now()) / 1000);

    // Süresi dolmuş token zaten reddedilir; listeye eklemek gereksiz yer kaplar.
    if (ttlSeconds <= 0) return;

    try {
      await this.redis.setex(
        this.key(jti),
        // Saat kayması payı: bir düğümün saati ileriyse token'ı hâlâ
        // geçerli sayabilir. Denylist bu pencerede de kapsamalıdır.
        ttlSeconds + TOKEN_TTL.CLOCK_TOLERANCE_SECONDS,
        reason,
      );
    } catch (error) {
      // KRİTİK: iptal yazılamadıysa token hâlâ geçerlidir. Bu, sessizce
      // geçilecek bir hata değildir — alarm üretmelidir.
      this.logger.error(
        { err: (error as Error).message, jti },
        'TOKEN IPTALI YAZILAMADI — token halen gecerli',
      );
      throw error;
    }
  }

  /**
   * Token iptal edilmiş mi?
   *
   * ARIZA DURUŞU: FAIL-CLOSED.
   *   Redis erişilemezse `true` DÖNMEZ (herkesi kilitlemek), ama `false` de
   *   sessizce dönmez. Hata yükseltilir ve JwtAuthGuard bunu 401 olarak
   *   yorumlar. Gerekçe: iptal kontrolünü atlayarak devam etmek, iptal
   *   edilmiş bir oturumun çalışmaya devam etmesi demektir — bu, kısa süreli
   *   erişilemezlikten daha ciddi bir sonuçtur.
   */
  async isRevoked(jti: string): Promise<boolean> {
    try {
      return await this.redis.exists(this.key(jti));
    } catch (error) {
      this.logger.error(
        { err: (error as Error).message, jti },
        'Iptal listesi okunamadi — istek reddediliyor (fail-closed)',
      );
      throw error;
    }
  }

  /**
   * Bir oturuma ait tüm token'ları iptal eder.
   * Oturum kimliği (`sid`) ile ilişkilendirilmiş jti'ler ayrı bir set'te tutulur.
   */
  async revokeSession(sessionId: string, jtis: readonly string[], expiresAt: number): Promise<void> {
    await Promise.all(jtis.map((jti) => this.revoke(jti, expiresAt, `session:${sessionId}`)));
  }

  private key(jti: string): string {
    return `denylist:${jti}`;
  }
}
