import { Controller, Get, Post, Delete, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { IsString, IsInt, IsOptional, IsEnum, Min, Max, MaxLength } from 'class-validator';

import { DlpRuleRepository, DlpIncidentRepository } from './dlp.repositories';
import { DlpService, DlpAction } from './dlp.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';

class UpsertRuleDto {
  @IsString() @MaxLength(50)
  key!: string;

  @IsString() @MaxLength(120)
  name!: string;

  @IsString() @MaxLength(500)
  pattern!: string;

  @IsOptional() @IsString()
  validator?: string;

  @IsEnum(DlpAction)
  action!: DlpAction;

  @IsInt() @Min(1) @Max(5)
  severity!: number;
}

class TestRuleDto {
  @IsString() @MaxLength(16_000)
  sample!: string;
}

@Controller({ path: 'dlp', version: '1' })
export class DlpController {
  constructor(
    private readonly rules: DlpRuleRepository,
    private readonly incidents: DlpIncidentRepository,
    private readonly dlp: DlpService,
    private readonly audit: AuditService,
  ) {}

  @Get('rules')
  @RequirePermissions('dlp.manage')
  async listRules(@CurrentUser() user: AuthenticatedUser) {
    const all = await this.rules.findAllActive();
    return { rules: all.filter((r) => r.orgId === user.orgId) };
  }

  @Post('rules')
  @RequirePermissions('dlp.manage')
  async upsertRule(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpsertRuleDto) {
    const id = await this.rules.upsert({
      orgId: user.orgId,
      key: dto.key,
      name: dto.name,
      pattern: dto.pattern,
      validator: dto.validator ?? null,
      action: dto.action,
      severity: dto.severity,
      appliesTo: null,
    });

    await this.audit.record({
      orgId: user.orgId,
      actorId: user.id,
      action: 'dlp.rule_upsert',
      resourceType: 'dlp_rule',
      resourceId: id,
      // Desen (pattern) metadata'ya YAZILIR: bir kuralın ne zaman
      // gevşetildiğini bilmek, uyum denetiminin gerektirdiği bir bilgidir.
      metadata: { key: dto.key, action: dto.action, pattern: dto.pattern },
    });

    return { id };
  }

  @Delete('rules/:key')
  @RequirePermissions('dlp.manage')
  async deactivateRule(@CurrentUser() user: AuthenticatedUser, @Param('key') key: string) {
    const removed = await this.rules.deactivate(user.orgId, key);

    await this.audit.record({
      orgId: user.orgId,
      actorId: user.id,
      action: 'dlp.rule_deactivate',
      resourceType: 'dlp_rule',
      resourceId: key,
      // Bir DLP kuralını kapatmak, korumayı azaltan bir eylemdir.
      metadata: { severity: 'high' },
    });

    return { removed };
  }

  /**
   * Kural testi — kaydetmeden önce deneme.
   *
   * Yönetici bir regex yazdığında ne yakalayacağını görmelidir. Bu olmadan
   * kurallar ya çok geniş (herkesi engeller) ya çok dar (hiçbir şey yakalamaz)
   * yazılır ve fark ancak üretimde anlaşılır.
   */
  @Post('test')
  @RequirePermissions('dlp.manage')
  async testSample(@CurrentUser() user: AuthenticatedUser, @Body() dto: TestRuleDto) {
    const result = await this.dlp.scan(dto.sample, {
      orgId: user.orgId,
      userId: user.id,
      channelId: '00000000-0000-0000-0000-000000000000',
      channelType: 'GROUP',
      isE2ee: false,
    });

    return {
      action: result.action,
      matches: result.matches,
      // Maskelenmiş sonuç döner; orijinal örnek yanıtta tekrarlanmaz.
      maskedPreview: result.body,
    };
  }

  /** İhlal özeti — kullanıcı ve kural bazında. */
  @Get('incidents')
  @RequirePermissions('dlp.manage')
  async incidentSummary(
    @CurrentUser() user: AuthenticatedUser,
    // `@Type()` bir ÖZELLİK dekoratörüdür, parametre dekoratörü değil —
    // burada kullanılamaz. Sorgu parametreleri her zaman string gelir,
    // dönüşüm `ParseIntPipe` ile yapılır. `optional: true` parametre
    // verilmediğinde hata atmasını engeller.
    @Query('days', new ParseIntPipe({ optional: true })) days?: number,
  ) {
    const windowDays = Math.min(Math.max(days ?? 30, 1), 365);
    const to = new Date();
    const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);

    return {
      summary: await this.incidents.summarizeByUser(user.orgId, from, to),
      range: { from, to },
    };
  }
}
