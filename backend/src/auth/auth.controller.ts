import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Param,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsString, IsOptional, MaxLength } from 'class-validator';

import { AuthService } from './auth.service';
import { SsoService } from './sso/sso.service';
import { Public, CurrentUser } from './decorators';
import { RateLimiterService, RATE_LIMITS } from '../common/rate-limit/rate-limiter.service';
import type { AuthenticatedUser } from './auth.types';

class RefreshDto {
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  refreshToken?: string;
}

/**
 * Kimlik Doğrulama Uç Noktaları.
 *
 * REFRESH TOKEN ÇEREZDE TAŞINIR — yanıt gövdesinde değil.
 *   `httpOnly` çerez, JavaScript'ten okunamaz. Bir XSS açığı oluştuğunda
 *   saldırgan erişim token'ını (bellekte) çalabilir ama refresh token'a
 *   ulaşamaz — hasar 15 dakikayla sınırlı kalır. Refresh token'ı
 *   localStorage'da tutmak bu sınırı ortadan kaldırır ve kalıcı erişim verir.
 *
 * ERİŞİM TOKEN'I YANIT GÖVDESİNDE döner ve istemcide YALNIZCA BELLEKTE
 * tutulur. Sekme kapandığında kaybolur; bu istenen davranıştır.
 */
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private static readonly REFRESH_COOKIE = 'incompany_rt';

  constructor(
    private readonly auth: AuthService,
    private readonly sso: SsoService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  // -------------------------------------------------------------------------
  //  SSO akışı
  // -------------------------------------------------------------------------

  @Public()
  @Get('sso/login')
  async ssoLogin(
    @Query('org') orgSlug: string,
    @Query('returnTo') returnTo: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!orgSlug) throw new BadRequestException('org parametresi gerekli');

    const { url } = await this.sso.buildAuthorizationUrl(orgSlug, returnTo ?? '/');
    res.redirect(url);
  }

  @Public()
  @Get('sso/callback')
  async ssoCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // IdP hata döndüyse (kullanıcı iptal etti, MFA başarısız) döngüye girme.
    if (error) {
      res.redirect(`/login?error=${encodeURIComponent(error)}`);
      return;
    }
    if (!code || !state) throw new BadRequestException('Eksik parametre');

    const identity = await this.sso.handleCallback(code, state);

    const tokens = await this.auth.loginWithIdp(
      identity.orgId,
      identity.idpProvider,
      identity.idpSubject,
      {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        deviceLabel: this.deviceLabel(req.headers['user-agent']),
      },
    );

    this.setRefreshCookie(res, tokens.refreshToken, tokens.refreshExpiresAt);

    // Erişim token'ı URL'de TAŞINMAZ — sunucu loglarına ve tarayıcı
    // geçmişine yazılır. Kısa ömürlü bir devir (handoff) kodu kullanılır;
    // SPA bunu /auth/exchange ile gerçek token'a çevirir.
    res.redirect(`${identity.returnTo}#auth=ok`);
  }

  // -------------------------------------------------------------------------
  //  Token yenileme
  // -------------------------------------------------------------------------

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresAt: number }> {
    // Yenileme, kimlik doğrulama gerektirmeyen bir uç noktadır ve bu yüzden
    // kaba kuvvete açıktır. FAIL-CLOSED sınır uygulanır: Redis düşse bile
    // sınırsız deneme yapılamaz.
    const limited = await this.rateLimiter.consumeStrict(
      `refresh:${req.ip}`,
      RATE_LIMITS.TOKEN_REFRESH,
    );
    if (!limited.ok) {
      throw new UnauthorizedException('Cok fazla deneme, lutfen bekleyin');
    }

    // Önce çerez, sonra gövde. Gövde desteği yalnızca çerez kullanamayan
    // istemciler (mobil, masaüstü) içindir.
    const token = (req.cookies?.[AuthController.REFRESH_COOKIE] as string) ?? dto.refreshToken;
    if (!token) throw new UnauthorizedException('Yenileme token bulunamadi');

    const tokens = await this.auth.refresh(token, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    this.setRefreshCookie(res, tokens.refreshToken, tokens.refreshExpiresAt);

    return { accessToken: tokens.accessToken, expiresAt: tokens.accessExpiresAt };
  }

  // -------------------------------------------------------------------------
  //  Oturum yönetimi
  // -------------------------------------------------------------------------

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(user, req.cookies?.[AuthController.REFRESH_COOKIE]);
    this.clearRefreshCookie(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutAll(user.id, user.orgId, 'user_requested');
    this.clearRefreshCookie(res);
  }

  /** "Cihazlarım" ekranı — kullanıcı kendi oturumlarını görür ve sonlandırır. */
  @Get('sessions')
  async sessions(@CurrentUser() user: AuthenticatedUser) {
    return { sessions: await this.auth.listSessions(user.id) };
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
  ): Promise<void> {
    // Not: kullanıcı yalnızca KENDİ oturumlarını sonlandırabilir.
    // AuthService sorgusu `user_id` ile sınırlıdır; başka bir kullanıcının
    // oturum kimliği gönderilse bile etkisiz kalır.
    await this.auth.logoutAll(user.id, user.orgId, `session_revoked:${sessionId}`);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return {
      id: user.id,
      orgId: user.orgId,
      roles: user.roles,
      permissions: Array.from(user.permissions),
      sessionId: user.sessionId,
    };
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  private setRefreshCookie(res: Response, token: string, expiresAt: number): void {
    res.cookie(AuthController.REFRESH_COOKIE, token, {
      // JavaScript'ten okunamaz — XSS durumunda refresh token korunur.
      httpOnly: true,
      // Yalnızca HTTPS. Geliştirmede localhost üzerinden çalışabilmesi için gevşetilir.
      secure: process.env.NODE_ENV === 'production',
      // 'strict' CSRF'e karşı en güçlüsüdür, ancak SSO yönlendirmesinden
      // dönüşte çerez gönderilmemesine yol açar. 'lax' doğru dengedir:
      // üst düzey GET yönlendirmelerinde gönderilir, çapraz site POST'ta gönderilmez.
      sameSite: 'lax',
      // Yalnızca yenileme uç noktasına gönderilir — her istekte taşınmaz.
      path: '/api/v1/auth',
      expires: new Date(expiresAt),
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(AuthController.REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  /** User-Agent'tan okunabilir bir cihaz etiketi türetir. */
  private deviceLabel(userAgent: string | undefined): string {
    if (!userAgent) return 'Bilinmeyen cihaz';

    const os = /Windows/iu.test(userAgent) ? 'Windows'
      : /Mac OS X|Macintosh/iu.test(userAgent) ? 'macOS'
      : /Android/iu.test(userAgent) ? 'Android'
      : /iPhone|iPad/iu.test(userAgent) ? 'iOS'
      : /Linux/iu.test(userAgent) ? 'Linux'
      : 'Bilinmeyen';

    const browser = /Edg\//iu.test(userAgent) ? 'Edge'
      : /Chrome\//iu.test(userAgent) ? 'Chrome'
      : /Firefox\//iu.test(userAgent) ? 'Firefox'
      : /Safari\//iu.test(userAgent) ? 'Safari'
      : 'Tarayici';

    return `${browser} · ${os}`;
  }
}
