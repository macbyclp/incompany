import {
  Injectable,
  CanActivate,
  UnauthorizedException,
  Logger,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../decorators';
import { TOKEN_TTL, type AuthenticatedUser, type JwtAccessPayload } from '../auth.types';
import { TokenDenylistService } from '../token-denylist.service';
import { UserSecurityCache } from '../user-security.cache';

/**
 * JWT Kimlik Doğrulama Guard'ı.
 *
 * APP_GUARD olarak global bağlanır → varsayılan davranış "kapalı".
 *
 * DOĞRULAMA ZİNCİRİ (her adım ayrı bir saldırıyı kapatır)
 *   1. Bearer şeması        → başlık biçimi
 *   2. İmza + algoritma     → `alg: none` ve algoritma karıştırma saldırısı
 *   3. iss / aud            → başka bir sistemin token'ının kabul edilmesi
 *   4. exp / nbf (+ tolerans) → süresi dolmuş token; NTP kayması toleransı
 *   5. jti denylist (Redis) → açık oturum sonlandırma ("her yerden çıkış")
 *   6. token_version        → rol/parola değişiminde toplu iptal
 *
 * 5 ve 6 neden gerekli? JWT tasarımı gereği durumsuzdur (stateless) —
 * yayınlandıktan sonra geri alınamaz. Kurumsal bir sistemde "kullanıcıyı hemen
 * çıkar" gerçek bir gerekliliktir (işten ayrılma, güvenlik olayı). Bu iki
 * kontrol, JWT'ye iptal yeteneği kazandırır. Maliyeti: istek başına bir Redis
 * araması (~0.3 ms, önbelleklenmiş).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly denylist: TokenDenylistService,
    private readonly userCache: UserSecurityCache,
  ) {
    this.issuer = this.config.getOrThrow<string>('JWT_ISSUER');
    this.audience = this.config.getOrThrow<string>('JWT_AUDIENCE');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // WebSocket bağlantıları handshake sırasında bir kez doğrulanır
    // (bkz. ChatGateway.handleConnection); burada yalnızca sonucu kullanılır.
    if (context.getType() === 'ws') {
      const client = context.switchToWs().getClient();
      if (!client.data?.user) {
        throw new UnauthorizedException('Socket kimlik dogrulamasi yapilmamis');
      }
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Erisim token bulunamadi');
    }

    const user = await this.verifyAccessToken(token);
    (request as Request & { user: AuthenticatedUser }).user = user;
    return true;
  }

  /**
   * Token doğrulama — HTTP ve WebSocket yollarınca paylaşılır.
   * Tek bir yerde olması, iki yolun farklı davranmasını yapısal olarak engeller.
   */
  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    let payload: JwtAccessPayload;

    try {
      payload = await this.jwt.verifyAsync<JwtAccessPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        // Algoritma beyaz listesi ZORUNLUDUR. Belirtilmezse kütüphane
        // token'ın kendi `alg` başlığına güvenir; saldırgan bunu `none` veya
        // (RSA kullanılıyorsa) `HS256` yaparak açık anahtarı imza sırrına çevirir.
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: TOKEN_TTL.CLOCK_TOLERANCE_SECONDS,
      });
    } catch (error) {
      const name = (error as Error).name;
      // Süre dolması ayrı bildirilir: istemcinin refresh akışını tetiklemesi
      // gerekir. Diğer tüm hatalar tek bir genel mesajla döner — hangi alanın
      // hatalı olduğunu söylemek, saldırgana geri bildirim vermek demektir.
      if (name === 'TokenExpiredError') {
        throw new UnauthorizedException({ code: 'TOKEN_EXPIRED', message: 'Erisim token suresi doldu' });
      }
      this.logger.debug({ err: name }, 'Token dogrulama basarisiz');
      throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: 'Gecersiz token' });
    }

    this.assertShape(payload);

    // Açık iptal: "tüm cihazlardan çıkış" veya tek oturum sonlandırma.
    if (await this.denylist.isRevoked(payload.jti)) {
      throw new UnauthorizedException({ code: 'TOKEN_REVOKED', message: 'Token iptal edilmis' });
    }

    // Toplu iptal: kullanıcı askıya alındı, rolü değişti veya parolası değişti.
    // Önbelleklenmiş kayıt (30 sn TTL) — DB'ye her istekte gidilmez.
    const security = await this.userCache.get(payload.org, payload.sub);
    if (!security) {
      throw new UnauthorizedException({ code: 'USER_NOT_FOUND', message: 'Kullanici bulunamadi' });
    }
    if (security.status !== 'ACTIVE') {
      throw new UnauthorizedException({ code: 'USER_INACTIVE', message: 'Hesap aktif degil' });
    }
    if (security.tokenVersion !== payload.tv) {
      throw new UnauthorizedException({
        code: 'TOKEN_STALE',
        message: 'Yetkileriniz degisti, lutfen tekrar giris yapin',
      });
    }

    return {
      id: payload.sub,
      orgId: payload.org,
      sessionId: payload.sid,
      roles: payload.roles,
      permissions: new Set(payload.perms),
      tokenId: payload.jti,
      tokenVersion: payload.tv,
      expiresAt: payload.exp * 1000,
    };
  }

  /**
   * Token'ı `Authorization: Bearer <token>` başlığından okur.
   *
   * Sorgu parametresi (`?token=`) BİLİNÇLİ OLARAK desteklenmez: URL'ler
   * erişim loglarına, tarayıcı geçmişine, proxy loglarına ve Referer
   * başlıklarına düz metin olarak yazılır.
   */
  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;

    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !value) return null;

    return value.trim() || null;
  }

  /**
   * Yapısal doğrulama. İmza geçerli olsa bile beklenen alanlar eksikse
   * `undefined` bir orgId ile sorgu çalıştırmak yerine erken başarısız olunur.
   */
  private assertShape(payload: JwtAccessPayload): void {
    const missing = (['sub', 'org', 'sid', 'jti'] as const).filter((k) => !payload[k]);
    if (missing.length > 0 || typeof payload.tv !== 'number' || !Array.isArray(payload.roles)) {
      this.logger.warn({ missing }, 'Token yapisi bozuk');
      throw new UnauthorizedException({ code: 'TOKEN_MALFORMED', message: 'Gecersiz token' });
    }
  }
}
