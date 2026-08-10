import { Controller, Get, Query, ForbiddenException } from '@nestjs/common';
import { IsOptional, IsString, IsInt, Min, Max, IsISO8601 } from 'class-validator';
import { Type } from 'class-transformer';

import { AuditService } from './audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthenticatedUser } from '../auth/auth.types';

class AuditQueryDto {
  @IsOptional() @IsString() actorId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() resourceType?: string;
  @IsOptional() @IsString() resourceId?: string;
  @IsOptional() @IsString() outcome?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;
}

/**
 * Denetim Kaydı Erişimi.
 *
 * ÖNEMLİ: DENETİM KAYDINI OKUMAK DA DENETLENİR.
 *   "Kim denetim kayıtlarına baktı?" sorusu, bir soruşturmada en az
 *   "kim ne yaptı?" kadar önemlidir. Denetim kaydını okuyabilen ama bunu
 *   yaparken iz bırakmayan bir yetkili, sistemin kör noktasıdır.
 */
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('logs')
  @RequirePermissions('audit.read')
  async search(@CurrentUser() user: AuthenticatedUser, @Query() query: AuditQueryDto) {
    // Varsayılan aralık: son 30 gün. Aralıksız sorgu, bölümlenmiş tabloda
    // TÜM partition'ları tarar ve veritabanını dakikalarca meşgul eder.
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    if (from > to) {
      throw new ForbiddenException('Baslangic tarihi bitis tarihinden sonra olamaz');
    }

    const result = await this.audit.search({
      // orgId İSTEMCİDEN ALINMAZ, token'dan gelir. Aksi halde bir yönetici
      // başka bir kiracının denetim kayıtlarını okuyabilir.
      orgId: user.orgId,
      actorId: query.actorId,
      action: query.action,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      outcome: query.outcome,
      from,
      to,
      limit: query.limit,
      offset: query.offset,
    });

    // Okuma eyleminin kendisi kaydedilir — kritik olay olduğu için senkron yazılır.
    await this.audit.record({
      orgId: user.orgId,
      actorId: user.id,
      action: 'audit.read',
      resourceType: 'audit_log',
      metadata: {
        filters: { action: query.action, actorId: query.actorId },
        resultCount: result.total,
        range: { from: from.toISOString(), to: to.toISOString() },
      },
    });

    return result;
  }

  /**
   * Hash zinciri doğrulaması.
   *
   * Kırılma tespiti, sistemdeki EN YÜKSEK öncelikli alarmdır: denetim
   * kayıtlarının değiştirildiği anlamına gelir. Günlük planlı görev olarak
   * da çalışır; bu uç nokta manuel doğrulama içindir.
   */
  @Get('verify-chain')
  @RequirePermissions('audit.read')
  async verifyChain(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    const result = await this.audit.verifyChain(user.orgId, fromDate, toDate);

    if (!result.valid) {
      await this.audit.record({
        orgId: user.orgId,
        actorId: user.id,
        action: 'audit.chain_broken',
        resourceType: 'audit_log',
        resourceId: result.brokenAt,
        outcome: 'FAILURE',
        metadata: { severity: 'critical', checked: result.checked },
      });
    }

    return result;
  }
}
