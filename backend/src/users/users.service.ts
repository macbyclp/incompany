import { Injectable, ForbiddenException, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { GlobalRole } from '@incompany/contracts';

import { UsersRepository, type AdminUserRecord, type DirectoryUserRecord } from './users.repository';
import { hashPassword } from '../auth/password.util';
import { UserSecurityCache } from '../auth/user-security.cache';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';

@Injectable()
export class UsersService {
  constructor(
    private readonly users: UsersRepository,
    private readonly userCache: UserSecurityCache,
    private readonly audit: AuditService,
  ) {}

  directory(orgId: string): Promise<DirectoryUserRecord[]> {
    return this.users.listForOrg(orgId);
  }

  resolve(orgId: string, ids: string[]): Promise<DirectoryUserRecord[]> {
    // Sunucu tarafı sınır: tek istekte 200 kimlik. Frontend zaten bu boyutta
    // parçalıyor (bkz. directory.store.ts) — burası son savunma hattıdır.
    return this.users.resolveByIds(orgId, ids.slice(0, 200));
  }

  adminList(orgId: string): Promise<AdminUserRecord[]> {
    return this.users.listForAdmin(orgId);
  }

  /**
   * Yönetim panelinden yeni kişi ekleme.
   *
   * Bu dağıtımda SSO zorunlu değildir (bkz. `password.util.ts` — parola ile
   * giriş de desteklenir). Bu yüzden burada rastgele bir geçici parola
   * üretilip YANITTA BİR KEZ döndürülür — yönetici bunu kişiye iletir.
   * Parola veritabanında yalnızca karması olarak durur, düz metin hiçbir
   * yerde saklanmaz.
   */
  async createUser(
    admin: AuthenticatedUser,
    input: { displayName: string; email: string; title?: string; roles: GlobalRole[] },
  ): Promise<{ id: string; temporaryPassword: string }> {
    if (input.roles.length === 0) {
      throw new BadRequestException('En az bir rol secilmelidir');
    }

    const temporaryPassword = randomBytes(9).toString('base64url'); // ~12 karakter, scrypt asgari sinirini gecer
    const passwordHash = await hashPassword(temporaryPassword);

    const { id } = await this.users.createProvisioned(
      admin.orgId,
      { displayName: input.displayName, email: input.email.toLowerCase(), title: input.title ?? null, roles: input.roles },
      passwordHash,
    );

    await this.audit.record({
      orgId: admin.orgId,
      actorId: admin.id,
      action: 'user.manage',
      resourceType: 'user',
      resourceId: id,
      metadata: { operation: 'create', roles: input.roles },
    });

    return { id, temporaryPassword };
  }

  async updateOwnProfile(user: AuthenticatedUser, patch: { displayName?: string; title?: string }): Promise<void> {
    await this.users.updateProfile(user.orgId, user.id, patch);
  }

  async adminUpdateUser(
    admin: AuthenticatedUser,
    userId: string,
    patch: { status?: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED'; roles?: GlobalRole[] },
  ): Promise<void> {
    if (userId === admin.id && (patch.status === 'SUSPENDED' || patch.status === 'DEPROVISIONED')) {
      // Kendi hesabını askıya almak, tüm organizasyonu yöneticisiz bırakabilir
      // (özellikle tek yönetici olan yeni kurulumlarda). Bu bilinçli engellenir.
      throw new ForbiddenException('Kendi hesabinizi askiya alamazsiniz');
    }

    await this.users.adminUpdate(admin.orgId, userId, patch);

    // Rol/durum değişikliği ANINDA etkili olmalı — TTL'nin dolmasını
    // beklemek (30 sn'e kadar) askıya alınmış bir kullanıcının o süre
    // boyunca erişmeye devam etmesi demektir.
    await this.userCache.invalidate(userId);

    await this.audit.record({
      orgId: admin.orgId,
      actorId: admin.id,
      action: patch.roles ? 'role.assign' : 'user.manage',
      resourceType: 'user',
      resourceId: userId,
      metadata: { operation: 'update', ...patch },
    });
  }
}
