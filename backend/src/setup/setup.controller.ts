import { Controller, Get, Post, Body, Req, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { IsString, IsEmail, MinLength, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';

import { SetupService } from './setup.service';
import { Public } from '../auth/decorators';

class BootstrapDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  organizationName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  adminDisplayName!: string;

  @IsEmail()
  @MaxLength(255)
  adminEmail!: string;

  // Asgari uzunluk burada TEKRAR edilir (SetupService.bootstrap içinde de
  // kontrol edilir) — istemci tarafı doğrulamayı atlayan biri bile,
  // sunucunun ilk savunma hattında (DTO) yakalanır; servis katmanındaki
  // kontrol ise doğrulama mantığını burada TEKRARLAMAK yerine kesin
  // otoritedir.
  @IsString()
  @MinLength(12)
  @MaxLength(200)
  adminPassword!: string;
}

/**
 * Kurulum Uç Noktaları.
 *
 * İKİSİ DE `@Public()`: bu sistemde henüz hiçbir kullanıcı ve token yokken
 * çağrılırlar. Güvenlik `SetupService.bootstrap`'teki tek-seferlik kapıya
 * (organizations tablosu boş mu?) dayanır — uç noktanın kendisi açık olsa
 * da, ikinci bir kurulum girişimi her zaman reddedilir.
 */
@Controller({ path: 'setup', version: '1' })
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Public()
  @Get('status')
  async status(): Promise<{ needsSetup: boolean }> {
    return { needsSetup: await this.setup.needsSetup() };
  }

  @Public()
  @Post('bootstrap')
  @HttpCode(HttpStatus.CREATED)
  async bootstrap(
    @Body() dto: BootstrapDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresAt: number; orgSlug: string }> {
    const result = await this.setup.bootstrap(
      {
        organizationName: dto.organizationName,
        adminDisplayName: dto.adminDisplayName,
        adminEmail: dto.adminEmail,
        adminPassword: dto.adminPassword,
      },
      {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        deviceLabel: 'Kurulum sihirbazi',
      },
    );

    // Diğer giriş yollarıyla AYNI çerez adı ve yolu kullanılır — sihirbaz
    // tamamlandıktan sonra kullanıcı, normal bir oturum açmış gibi devam
    // eder ve `/auth/refresh` aynı şekilde çalışır.
    res.cookie('incompany_rt', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      expires: new Date(result.refreshExpiresAt),
    });

    return {
      accessToken: result.accessToken,
      expiresAt: result.accessExpiresAt,
      orgSlug: result.orgSlug,
    };
  }
}
