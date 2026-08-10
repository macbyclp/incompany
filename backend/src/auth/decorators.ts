import {
  SetMetadata,
  createParamDecorator,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { GlobalRole } from '@incompany/contracts';

import type { AuthenticatedUser } from './auth.types';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';
export const PERMISSIONS_KEY = 'auth:permissions';

/**
 * Uç noktayı kimlik doğrulamasından muaf tutar.
 *
 * GÜVENLİK DURUŞU: JwtAuthGuard uygulamaya GLOBAL olarak bağlanır (APP_GUARD).
 * Yani varsayılan "kapalı"dır — yeni bir controller yazan geliştirici guard
 * eklemeyi unutursa uç nokta korumasız kalmaz, tam tersine erişilemez olur.
 * Açmak bilinçli bir eylem gerektirir: @Public().
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Asgari rol seviyesi. Hiyerarşiktir: @Roles(DEPT_MANAGER) yazıldığında
 * ADMIN de geçer.
 */
export const Roles = (...roles: GlobalRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * İnce taneli izin kontrolü. Roller yerine bunu tercih edin: rol adı zamanla
 * değişir, izin anlamı değişmez.
 *
 * TÜM listelenen izinler gereklidir (AND semantiği).
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Doğrulanmış kullanıcıyı enjekte eder.
 *
 *   @Get('me')
 *   me(@CurrentUser() user: AuthenticatedUser) { ... }
 *   me(@CurrentUser('id') userId: string) { ... }
 *
 * Guard çalışmadıysa (yanlış yapılandırma) sessizce `undefined` dönmek yerine
 * istisna atar — sessiz `undefined`, yetki kontrolünün atlandığı hataları
 * üretime kadar taşır.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const user =
      ctx.getType() === 'ws'
        ? (ctx.switchToWs().getClient().data?.user as AuthenticatedUser | undefined)
        : (ctx.switchToHttp().getRequest().user as AuthenticatedUser | undefined);

    if (!user) {
      throw new UnauthorizedException(
        'Kimlik baglami yok — @CurrentUser() @Public() bir uc noktada kullanilmis olabilir',
      );
    }

    return field ? user[field] : user;
  },
);
