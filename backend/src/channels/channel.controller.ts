import { Controller, Get, Post, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import {
  IsEnum, IsString, IsOptional, IsArray, IsUUID, IsBoolean, MaxLength, ArrayMaxSize,
} from 'class-validator';
import { ChannelType, ChannelVisibility } from '@incompany/contracts';

import { ChannelService } from './channel.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthenticatedUser } from '../auth/auth.types';

class CreateChannelDto {
  @IsEnum(ChannelType)
  type!: ChannelType;

  @IsString()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  topic?: string;

  @IsOptional()
  @IsEnum(ChannelVisibility)
  visibility?: ChannelVisibility;

  @IsOptional()
  @IsUUID('4')
  departmentId?: string;

  @IsOptional()
  @IsArray()
  // Tek seferde sınırsız üye eklemek, tek bir istekle binlerce satır
  // yazmak ve binlerce bildirim tetiklemek demektir.
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  memberIds?: string[];

  @IsOptional()
  @IsBoolean()
  e2eeEnabled?: boolean;
}

class MembersDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  userIds!: string[];
}

@Controller({ path: 'channels', version: '1' })
export class ChannelController {
  constructor(private readonly channels: ChannelService) {}

  /** Kenar çubuğu — kullanıcının kanalları ve okunmamış sayaçları. */
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    return { channels: await this.channels.listForUser(user) };
  }

  @Post()
  @RequirePermissions('channel.create')
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateChannelDto) {
    return this.channels.create(user, dto);
  }

  /**
   * DM açar veya mevcut olanı döndürür.
   *
   * İdempotenttir: aynı iki kişi için defalarca çağrılsa da tek kanal
   * oluşur (şemadaki `dm_key` benzersiz indeksi bunu garanti eder).
   */
  @Post('dm/:userId')
  @HttpCode(HttpStatus.OK)
  async openDm(@CurrentUser() user: AuthenticatedUser, @Param('userId') targetUserId: string) {
    return this.channels.openDm(user, targetUserId);
  }

  @Get(':id/members')
  async listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') channelId: string,
  ) {
    return { members: await this.channels.listMembers(user, channelId) };
  }

  @Post(':id/members')
  @HttpCode(HttpStatus.OK)
  async addMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') channelId: string,
    @Body() dto: MembersDto,
  ) {
    const added = await this.channels.addMembers(user, channelId, dto.userIds);
    return { added };
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') channelId: string,
    @Param('userId') targetUserId: string,
  ): Promise<void> {
    await this.channels.removeMember(user, channelId, targetUserId);
  }

  /** Kullanıcının kendi ayrılması — üye yönetimi yetkisi gerektirmez. */
  @Delete(':id/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  async leave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') channelId: string,
  ): Promise<void> {
    await this.channels.removeMember(user, channelId, user.id);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') channelId: string,
  ): Promise<void> {
    await this.channels.archive(user, channelId);
  }
}
