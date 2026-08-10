import {
  Injectable,
  CanActivate,
  ForbiddenException,
  Logger,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GlobalRole } from '@incompany/contracts';

import { ROLES_KEY, PERMISSIONS_KEY } from '../decorators';
import { satisfiesRole, type AuthenticatedUser } from '../auth.types';
import { AuditService } from '../../audit/audit.service';

/**
 * RBAC Yetkilendirme Guard'ı.
 *
 * JwtAuthGuard'dan SONRA çalışır (APP_GUARD sırası önemlidir):
 *   "Sen kimsin?" → JwtAuthGuard
 *   "Bunu yapabilir misin?" → RolesGuard
 *
 * İKİ SEVİYE:
 *   @Roles(...)               — kaba, hiyerarşik (ADMIN > DEPT_MANAGER > EMPLOYEE)
 *   @RequirePermissions(...)  — ince, düz (AND semantiği)
 *
 * İkisi birlikte kullanılırsa HER İKİSİ de sağlanmalıdır.
 *
 * Reddedilen her erişim denetim kaydına yazılır. Bir hesabın yetkisi olmayan
 * uç noktaları taraması, hesabın ele geçirildiğinin en erken sinyalidir.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<GlobalRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const hasRoleRule = requiredRoles?.length > 0;
    const hasPermRule = requiredPermissions?.length > 0;
    if (!hasRoleRule && !hasPermRule) return true;

    const user = this.extractUser(context);
    if (!user) {
      // Buraya düşülüyorsa JwtAuthGuard atlanmıştır — yapılandırma hatası.
      this.logger.error('RolesGuard kimlik baglami olmadan calisti — guard sirasi hatali');
      throw new ForbiddenException('Yetkilendirme baglami eksik');
    }

    if (hasRoleRule) {
      // Hiyerarşik: gerekli rollerden HERHANGİ birini karşılamak yeterlidir.
      const ok = requiredRoles.some((role) => satisfiesRole(user.roles, role));
      if (!ok) {
        await this.denyAndAudit(context, user, {
          reason: 'role',
          required: requiredRoles,
          actual: user.roles,
        });
      }
    }

    if (hasPermRule) {
      // AND semantiği: listelenen tüm izinler gereklidir.
      const missing = requiredPermissions.filter((p) => !user.permissions.has(p));
      if (missing.length > 0) {
        await this.denyAndAudit(context, user, { reason: 'permission', missing });
      }
    }

    return true;
  }

  private extractUser(context: ExecutionContext): AuthenticatedUser | undefined {
    return context.getType() === 'ws'
      ? context.switchToWs().getClient().data?.user
      : context.switchToHttp().getRequest().user;
  }

  /**
   * Reddi denetim kaydına yazar ve istisna atar.
   *
   * İstemciye dönen mesaj neyin eksik olduğunu SÖYLEMEZ. "audit.read izniniz
   * yok" demek, saldırgana izin adlarının haritasını çıkarma imkânı verir.
   * Ayrıntı yalnızca denetim kaydında bulunur.
   */
  private async denyAndAudit(
    context: ExecutionContext,
    user: AuthenticatedUser,
    detail: Record<string, unknown>,
  ): Promise<never> {
    const handler = `${context.getClass().name}.${context.getHandler().name}`;

    // Denetim yazımı başarısız olsa bile ERİŞİM REDDEDİLMELİDİR.
    // Loglama hatasının yetki kontrolünü açması kabul edilemez.
    try {
      await this.audit.record({
        orgId: user.orgId,
        actorId: user.id,
        action: 'authz.denied',
        resourceType: 'endpoint',
        resourceId: handler,
        outcome: 'DENIED',
        metadata: detail,
      });
    } catch (error) {
      this.logger.error({ err: (error as Error).message }, 'Denetim kaydi yazilamadi');
    }

    this.logger.warn({ userId: user.id, handler, ...detail }, 'Erisim reddedildi');
    throw new ForbiddenException('Bu islem icin yetkiniz yok');
  }
}
