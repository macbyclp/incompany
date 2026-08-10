import { Injectable, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ChannelType, ChannelVisibility, ChannelMemberRole, GlobalRole } from '@incompany/contracts';

import { ChannelRepository, type ChannelRecord } from './channel.repository';
import { ChannelPolicyService } from './channel-policy.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { sanitizePlainText } from '../chat/sanitize';
import type { AuthenticatedUser } from '../auth/auth.types';

/**
 * Kanal İş Mantığı.
 *
 * Kanal oluşturmanın en kritik kararı DUYURU KANALLARIDIR: yalnızca
 * yetkililerin yazabildiği kanallar. Bu, teknik olarak kolay ama YÖNETİMSEL
 * olarak riskli bir özelliktir — "herkese duyuru gönderebilme" yetkisi,
 * yanlış ellerde kurumsal bir kimlik avı (phishing) aracına dönüşür.
 * Bu yüzden duyuru kanalı oluşturmak açık bir izin gerektirir.
 */
@Injectable()
export class ChannelService {
  constructor(
    private readonly channels: ChannelRepository,
    private readonly policy: ChannelPolicyService,
    private readonly audit: AuditService,
    private readonly db: DatabaseService,
  ) {}

  async create(
    user: AuthenticatedUser,
    input: {
      type: ChannelType;
      name: string;
      topic?: string;
      visibility?: ChannelVisibility;
      departmentId?: string;
      memberIds?: string[];
      e2eeEnabled?: boolean;
    },
  ): Promise<ChannelRecord> {
    if (!user.permissions.has('channel.create')) {
      throw new ForbiddenException('Kanal olusturma yetkiniz yok');
    }

    // Duyuru kanalı ayrı bir izin gerektirir.
    if (input.type === ChannelType.ANNOUNCEMENT && !user.permissions.has('announcement.post')) {
      throw new ForbiddenException('Duyuru kanali olusturma yetkiniz yok');
    }

    // Departman kanalı yalnızca o departmanın yöneticisi veya ADMIN
    // tarafından oluşturulabilir.
    if (input.type === ChannelType.DEPARTMENT) {
      if (!input.departmentId) {
        throw new BadRequestException('Departman kanali icin departmentId gerekli');
      }
      await this.assertDepartmentAuthority(user, input.departmentId);
    }

    // E2EE kanalı geri alınamaz bir karardır (şemada trigger ile korunur).
    // Kullanıcının bunun sonuçlarını bildiğinden emin olmak arayüzün işidir;
    // burada yalnızca yetki kontrolü yapılır.
    if (input.e2eeEnabled && !user.roles.includes(GlobalRole.ADMIN)) {
      throw new ForbiddenException('E2EE kanal olusturma yalnizca yoneticilere aciktir');
    }

    const name = sanitizePlainText(input.name, 80);
    if (name.length === 0) throw new BadRequestException('Kanal adi bos olamaz');

    const channel = await this.channels.create({
      orgId: user.orgId,
      type: input.type,
      visibility: input.visibility ?? ChannelVisibility.PRIVATE,
      name,
      slug: this.slugify(name),
      topic: input.topic ? sanitizePlainText(input.topic, 250) : null,
      departmentId: input.departmentId ?? null,
      e2eeEnabled: input.e2eeEnabled ?? false,
      retentionId: null,
      createdBy: user.id,
      memberIds: input.memberIds ?? [],
    });

    await this.audit.record({
      orgId: user.orgId,
      actorId: user.id,
      action: input.e2eeEnabled ? 'channel.e2ee_enabled' : 'channel.create',
      resourceType: 'channel',
      resourceId: channel.id,
      metadata: { type: input.type, memberCount: (input.memberIds?.length ?? 0) + 1 },
    });

    return channel;
  }

  async openDm(user: AuthenticatedUser, targetUserId: string): Promise<ChannelRecord> {
    // Hedef kullanıcı AYNI organizasyonda olmalıdır. Bu kontrol olmadan,
    // bir kullanıcı kimliği tahmin ederek başka bir kiracıya DM açabilir.
    // `users` RLS'lidir (`tenant_isolation_users`) — `withTenant` olmadan
    // `app.current_org` bu bağlantıda hiç ayarlanmamışsa politika ifadesi
    // (`current_setting(...)::uuid`) boş dizeyi uuid'ye çevirmeye çalışır
    // ve HATA fırlatır (`invalid input syntax for type uuid`) — DM açma
    // her zaman 500 ile başarısız oluyordu, kök neden buydu.
    const target = await this.db.withTenant(user.orgId, (client) =>
      client
        .query<{ id: string }>(
          `SELECT id FROM users WHERE id = $1 AND org_id = $2 AND status = 'ACTIVE' AND deleted_at IS NULL`,
          [targetUserId, user.orgId],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!target) throw new ForbiddenException('Kullanici bulunamadi');

    return this.channels.findOrCreateDm(user.orgId, user.id, targetUserId);
  }

  async listForUser(user: AuthenticatedUser) {
    return this.channels.listForUser(user.orgId, user.id);
  }

  /**
   * Üye listesi — üyelik doğrulaması ZORUNLUDUR.
   *
   * Kanalın üyesi olmayan bir kullanıcı, kanalın kimlerden oluştuğunu
   * göremez. Bu kontrol olmadan, bir kanal kimliğini tahmin eden herhangi
   * biri organizasyonun kim-kimle-aynı-kanalda bilgisini toplayabilir.
   */
  async listMembers(user: AuthenticatedUser, channelId: string) {
    const membership = await this.channels.findMembership(channelId, user.id);
    if (!membership || membership.leftAt) {
      throw new ForbiddenException('Bu kanalin uyesi degilsiniz');
    }
    return this.channels.listMembersWithProfile(channelId, user.orgId);
  }

  async addMembers(
    user: AuthenticatedUser,
    channelId: string,
    userIds: string[],
  ): Promise<number> {
    await this.assertChannelManagement(user, channelId);

    const added = await this.channels.addMembers(user.orgId, channelId, userIds, user.id);

    // Önbellek geçersizleştirme ZORUNLUDUR. Atlanırsa yeni üye 60 saniye
    // boyunca kanala erişemez (negatif önbellek hâlâ geçerlidir).
    await Promise.all(userIds.map((id) => this.policy.invalidate(channelId, id)));

    await this.audit.record({
      orgId: user.orgId,
      actorId: user.id,
      action: 'channel.member_add',
      resourceType: 'channel',
      resourceId: channelId,
      metadata: { addedCount: added, userIds },
    });

    return added;
  }

  async removeMember(user: AuthenticatedUser, channelId: string, targetUserId: string): Promise<void> {
    // Kullanıcı kendini her zaman çıkarabilir; başkasını çıkarmak yetki ister.
    if (targetUserId !== user.id) {
      await this.assertChannelManagement(user, channelId);
    }

    await this.channels.removeMember(user.orgId, channelId, targetUserId);

    // KRİTİK: önbellek temizlenmezse çıkarılan kullanıcı bir dakika daha
    // mesaj gönderebilir. Bu, kabul edilebilir bir gecikme DEĞİLDİR.
    await this.policy.invalidate(channelId, targetUserId);

    await this.audit.record({
      orgId: user.orgId,
      actorId: user.id,
      action: 'channel.member_remove',
      resourceType: 'channel',
      resourceId: channelId,
      metadata: { targetUserId, selfLeave: targetUserId === user.id },
    });
  }

  async archive(user: AuthenticatedUser, channelId: string): Promise<void> {
    if (!user.permissions.has('channel.archive')) {
      await this.assertChannelManagement(user, channelId);
    }

    await this.channels.archive(user.orgId, channelId);

    await this.audit.record({
      orgId: user.orgId,
      actorId: user.id,
      action: 'channel.archive',
      resourceType: 'channel',
      resourceId: channelId,
    });
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  private async assertChannelManagement(user: AuthenticatedUser, channelId: string): Promise<void> {
    if (user.permissions.has('channel.member.manage')) return;

    const membership = await this.channels.findMembership(channelId, user.id);
    const isStaff =
      membership?.role === ChannelMemberRole.OWNER ||
      membership?.role === ChannelMemberRole.MODERATOR;

    if (!isStaff) throw new ForbiddenException('Bu kanali yonetme yetkiniz yok');
  }

  /**
   * Departman yetkisi kontrolü.
   *
   * Materialized path sayesinde ALT AĞAÇ da kapsanır: "BT" yöneticisi,
   * "BT / Backend" departmanının kanalını da oluşturabilir. Yalnızca
   * doğrudan eşleşmeye bakmak, çok seviyeli organizasyonlarda yöneticileri
   * kendi alt birimlerinden kilitler.
   */
  private async assertDepartmentAuthority(
    user: AuthenticatedUser,
    departmentId: string,
  ): Promise<void> {
    if (user.roles.includes(GlobalRole.ADMIN)) return;

    const authorized = await this.db.queryMaybe<{ id: string }>(
      `SELECT d.id
         FROM departments d
        WHERE d.id = $1 AND d.org_id = $2
          AND (
            d.manager_id = $3
            OR EXISTS (
              SELECT 1 FROM departments ancestor
               WHERE ancestor.manager_id = $3
                 AND ancestor.org_id = d.org_id
                 AND d.path LIKE ancestor.path || '%'
            )
          )`,
      [departmentId, user.orgId, user.id],
    );

    if (!authorized) {
      throw new ForbiddenException('Bu departman icin kanal olusturma yetkiniz yok');
    }
  }

  /** Türkçe karakterleri de kapsayan URL-güvenli slug. */
  private slugify(name: string): string {
    const turkishMap: Record<string, string> = {
      ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
      Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u',
    };

    return name
      .replace(/[çğıöşüÇĞİÖŞÜ]/gu, (char) => turkishMap[char] ?? char)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/gu, '')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 60);
  }
}
