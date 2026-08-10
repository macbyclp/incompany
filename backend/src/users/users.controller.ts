import { Controller, Get, Post, Patch, Body, Param } from '@nestjs/common';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ArrayMaxSize,
} from 'class-validator';
import { GlobalRole } from '@incompany/contracts';

import { UsersService } from './users.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthenticatedUser } from '../auth/auth.types';

class ResolveUsersDto {
  @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true })
  userIds!: string[];
}

class UpdateProfileDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80)
  displayName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  title?: string;
}

class CreateUserDto {
  @IsString() @MinLength(2) @MaxLength(80)
  displayName!: string;

  @IsEmail()
  email!: string;

  @IsOptional() @IsString() @MaxLength(120)
  title?: string;

  @IsArray() @ArrayMaxSize(3) @IsEnum(GlobalRole, { each: true })
  roles!: GlobalRole[];
}

class AdminUpdateUserDto {
  @IsOptional() @IsEnum(['ACTIVE', 'SUSPENDED', 'DEPROVISIONED'])
  status?: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED';

  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsEnum(GlobalRole, { each: true })
  roles?: GlobalRole[];
}

/**
 * Kullanıcı Dizini — organizasyon içi herkesin görebileceği uç noktalar.
 *
 * Kanal üyesi eklemek, DM başlatmak, mesaj göndereni göstermek için gerekir.
 * Hassas alanlar (rol, durum, son giriş) burada YOKTUR — onlar
 * `AdminUsersController`'da, `user.manage` izniyle korunur.
 */
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async directory(@CurrentUser() user: AuthenticatedUser) {
    return { users: await this.users.directory(user.orgId) };
  }

  @Post('resolve')
  async resolve(@CurrentUser() user: AuthenticatedUser, @Body() dto: ResolveUsersDto) {
    return { users: await this.users.resolve(user.orgId, dto.userIds) };
  }

  @Patch('me')
  async updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    await this.users.updateOwnProfile(user, dto);
    return { ok: true };
  }

  /**
   * Tercihler için kalıcı bir sunucu tarafı sütun/tablo YOKTUR — tema/
   * bildirim tercihleri şu an yalnızca istemcide (`localStorage`) durur.
   * Frontend bu isteğin başarısızlığını zaten sessizce yutar (bkz.
   * `preferences.store.ts`), bu yüzden burada kasıtlı olarak no-op 200
   * dönülür: cihazlar arası senkron henüz yok ama istek en azından hataya
   * düşmüyor. Gerçek kalıcılık istenirse `users.preferences jsonb`
   * sütunu eklenmesi gerekir.
   */
  @Patch('me/preferences')
  async updatePreferences() {
    return { ok: true };
  }
}

/**
 * Yönetim Paneli — kişi ekleme/rol atama/askıya alma.
 *
 * TÜMÜ `user.manage` GEREKTİRİR. Bootstrap sırasında oluşturulan ilk
 * yönetici bu izne sahiptir (sistem ADMIN rolü tüm izinleri taşır, bkz.
 * 001_schema.sql).
 */
@Controller({ path: 'admin/users', version: '1' })
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('user.manage')
  async list(@CurrentUser() user: AuthenticatedUser) {
    return { users: await this.users.adminList(user.orgId) };
  }

  @Post()
  @RequirePermissions('user.manage')
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUserDto) {
    return this.users.createUser(user, dto);
  }

  @Patch(':userId')
  @RequirePermissions('user.manage')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    await this.users.adminUpdateUser(user, userId, dto);
    return { ok: true };
  }
}
