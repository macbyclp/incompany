import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SsoService } from './sso/sso.service';
import { TokenDenylistService } from './token-denylist.service';
import { UserSecurityCache } from './user-security.cache';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';

/**
 * Kimlik ve Yetki Modülü.
 *
 * `JwtModule` sırsız kaydedilir: her imzalama ve doğrulama çağrısında sır
 * AÇIKÇA verilir. Modül seviyesinde tek bir sır tanımlansaydı, erişim ve
 * refresh token'ları aynı anahtarla imzalanır ve bir refresh token erişim
 * token'ı olarak kabul edilebilir hale gelirdi.
 *
 * `JwtAuthGuard` ve `RolesGuard` hem burada sağlanır hem dışa verilir:
 * `APP_GUARD` olarak global bağlanırlar (bkz. app.module.ts) ve ayrıca
 * ChatGateway handshake doğrulamasında doğrudan kullanılırlar.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    SsoService,
    TokenDenylistService,
    UserSecurityCache,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [AuthService, TokenDenylistService, UserSecurityCache, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
