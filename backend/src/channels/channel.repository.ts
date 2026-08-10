import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ChannelType, ChannelVisibility, ChannelMemberRole } from '@incompany/contracts';

import { DatabaseService } from '../common/database/database.service';
import { KeyManagementService } from '../common/crypto/key-management.service';

export interface ChannelRecord {
  id: string;
  orgId: string;
  type: ChannelType;
  visibility: ChannelVisibility;
  name: string | null;
  slug: string | null;
  topic: string | null;
  departmentId: string | null;
  lastSeq: number;
  e2eeEnabled: boolean;
  retentionId: string | null;
  archivedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface MembershipRecord {
  channelId: string;
  userId: string;
  role: ChannelMemberRole;
  lastReadSeq: number;
  lastDeliveredSeq: number;
  isMuted: boolean;
  notifyLevel: 'ALL' | 'MENTIONS' | 'NONE';
  joinedAt: Date;
  leftAt: Date | null;
}

export interface ChannelOverview extends ChannelRecord {
  unreadCount: number;
  lastReadSeq: number;
  isPinned: boolean;
  isMuted: boolean;
  /** Yalnızca DM kanallarında dolu — karşı tarafın kullanıcı kimliği. */
  peerUserId?: string;
}

interface RawChannel {
  id: string;
  org_id: string;
  type: ChannelType;
  visibility: ChannelVisibility;
  name: string | null;
  slug: string | null;
  topic: string | null;
  department_id: string | null;
  last_seq: string;
  e2ee_enabled: boolean;
  retention_id: string | null;
  archived_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

@Injectable()
export class ChannelRepository {
  private readonly logger = new Logger(ChannelRepository.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly kms: KeyManagementService,
  ) {}

  // -------------------------------------------------------------------------
  //  Okuma
  // -------------------------------------------------------------------------

  /**
   * `channels` tablosu RLS'lidir (`tenant_isolation_channels`) — `orgId`
   * `withTenant`'a verilir. Bu aynı zamanda kiracılar arası erişimi de
   * doğal olarak engeller: başka bir org'un kanal ID'si verilirse RLS
   * satırı gizler ve `null` döner — çağıranların ayrıca `channel.orgId`
   * karşılaştırması yapmasına gerek kalmaz (yine de savunma amaçlı durur).
   */
  async findById(channelId: string, orgId: string): Promise<ChannelRecord | null> {
    const raw = await this.db.withTenant(orgId, (client) =>
      client
        .query<RawChannel>(
          `SELECT id, org_id, type, visibility, name, slug, topic, department_id,
                  last_seq, e2ee_enabled, retention_id, archived_at, created_by, created_at
             FROM channels WHERE id = $1`,
          [channelId],
        )
        .then((r) => r.rows[0] ?? null),
    );
    return raw ? this.toRecord(raw) : null;
  }

  async findMembership(channelId: string, userId: string): Promise<MembershipRecord | null> {
    const raw = await this.db.queryMaybe<{
      channel_id: string;
      user_id: string;
      role: ChannelMemberRole;
      last_read_seq: string;
      last_delivered_seq: string;
      is_muted: boolean;
      muted_until: Date | null;
      notify_level: 'ALL' | 'MENTIONS' | 'NONE';
      joined_at: Date;
      left_at: Date | null;
    }>(
      `SELECT channel_id, user_id, role, last_read_seq, last_delivered_seq,
              is_muted, muted_until, notify_level, joined_at, left_at
         FROM channel_members
        WHERE channel_id = $1 AND user_id = $2`,
      [channelId, userId],
    );

    if (!raw) return null;

    return {
      channelId: raw.channel_id,
      userId: raw.user_id,
      role: raw.role,
      lastReadSeq: Number(raw.last_read_seq),
      lastDeliveredSeq: Number(raw.last_delivered_seq),
      // Süreli sessize alma dolduysa artık sessiz değildir.
      isMuted: raw.is_muted && (!raw.muted_until || raw.muted_until > new Date()),
      notifyLevel: raw.notify_level,
      joinedAt: raw.joined_at,
      leftAt: raw.left_at,
    };
  }

  /** Bildirim ve rozet yayını için aktif üye kimlikleri. */
  async listMemberIds(channelId: string): Promise<string[]> {
    const rows = await this.db.query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1 AND left_at IS NULL',
      [channelId],
    );
    return rows.map((r) => r.user_id);
  }

  /**
   * Üye yönetimi paneli için isim/unvan ile zenginleştirilmiş liste.
   * `users` tablosu RLS'lidir — `withTenant` şart, aksi halde JOIN
   * sessizce sıfır satıra düşer.
   */
  async listMembersWithProfile(channelId: string, orgId: string): Promise<Array<{
    userId: string;
    displayName: string;
    email: string;
    title: string | null;
    role: ChannelMemberRole;
    joinedAt: Date;
  }>> {
    const rows = await this.db.withTenant(orgId, (client) =>
      client
        .query<{
          user_id: string;
          display_name: string;
          email: string;
          title: string | null;
          role: ChannelMemberRole;
          joined_at: Date;
        }>(
          `SELECT cm.user_id, u.display_name, u.email, u.title, cm.role, cm.joined_at
             FROM channel_members cm
             JOIN users u ON u.id = cm.user_id
            WHERE cm.channel_id = $1 AND cm.left_at IS NULL
            ORDER BY cm.role, u.display_name`,
          [channelId],
        )
        .then((r) => r.rows),
    );

    return rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      email: r.email,
      title: r.title,
      role: r.role,
      joinedAt: r.joined_at,
    }));
  }

  /**
   * Kenar çubuğu — kullanıcının kanalları ve okunmamış sayıları, tek sorguda.
   *
   * `withTenant` KULLANILIR: `channels` tablosu `tenant_isolation_channels`
   * RLS politikasıyla korunur (`app.current_org` gerektirir). Düz `query`
   * ile çağrıldığında bu SELECT HATA VERMEZ — sessizce sıfır satır döner.
   * Sonuç: kanal gerçekten oluşturulur (bkz. `create`, o zaten `withTenant`
   * kullanıyordu) ama kenar çubuğu boş kalır — "kanal oluşturdum ama
   * görünmüyor" şikâyetinin kök nedeni buydu.
   */
  async listForUser(orgId: string, userId: string): Promise<ChannelOverview[]> {
    const rows = await this.db.withTenant(orgId, (client) =>
      client
        .query<RawChannel & {
          unread_count: string;
          last_read_seq: string;
          is_pinned: boolean;
          is_muted: boolean;
          peer_user_id: string | null;
        }>(
          `SELECT c.id, c.org_id, c.type, c.visibility, c.name, c.slug, c.topic,
                  c.department_id, c.last_seq, c.e2ee_enabled, c.retention_id,
                  c.archived_at, c.created_by, c.created_at,
                  GREATEST(c.last_seq - cm.last_read_seq, 0) AS unread_count,
                  cm.last_read_seq, cm.is_pinned, cm.is_muted,
                  -- DM'in karşı tarafı: aynı kanalın DIŞINDA kalan tek üye.
                  -- Bu olmadan frontend DM'in "kiminle" olduğunu hiç bilemez
                  -- ve başlık sonsuza kadar "…" görünür (bkz. directory.
                  -- store.ts'in peerUserId'ye bağlı çözümleme mantığı).
                  (SELECT cm2.user_id FROM channel_members cm2
                    WHERE cm2.channel_id = c.id AND cm2.user_id != $1
                    LIMIT 1) AS peer_user_id
             FROM channel_members cm
             JOIN channels c ON c.id = cm.channel_id
            WHERE cm.user_id = $1 AND cm.left_at IS NULL
              AND c.org_id = $2 AND c.archived_at IS NULL
            -- Sabitlenmiş kanallar üstte, sonra en son mesaj alanlar.
            ORDER BY cm.is_pinned DESC, c.last_message_at DESC NULLS LAST`,
          [userId, orgId],
        )
        .then((r) => r.rows),
    );

    return rows.map((raw) => ({
      ...this.toRecord(raw),
      unreadCount: Number(raw.unread_count),
      lastReadSeq: Number(raw.last_read_seq),
      isPinned: raw.is_pinned,
      isMuted: raw.is_muted,
      peerUserId: raw.type === 'DM' ? raw.peer_user_id ?? undefined : undefined,
    }));
  }

  // -------------------------------------------------------------------------
  //  Yazma
  // -------------------------------------------------------------------------

  /**
   * Kanal oluşturur ve şifreleme anahtarını (DEK) üretir.
   *
   * ANAHTAR OLUŞTURMA AYNI TRANSACTION'DA OLMALI. Kanal anahtarsız
   * oluşturulursa ilk mesaj gönderiminde şifreleme başarısız olur ve
   * kanal kalıcı olarak kullanılamaz hale gelir.
   */
  async create(input: {
    orgId: string;
    type: ChannelType;
    visibility: ChannelVisibility;
    name: string | null;
    slug: string | null;
    topic: string | null;
    departmentId: string | null;
    e2eeEnabled: boolean;
    retentionId: string | null;
    createdBy: string;
    memberIds: string[];
  }): Promise<ChannelRecord> {
    const channelId = randomUUID();

    // DEK, transaction DIŞINDA üretilip sarmalanır: KMS çağrısı bir ağ
    // işlemidir ve transaction'ı gereksiz yere uzun tutmamalıdır.
    const dek = randomBytes(32);
    let wrappedDek: Buffer;
    try {
      wrappedDek = await this.kms.wrapKey(dek);
    } finally {
      dek.fill(0);
    }

    return this.db.withTenant(input.orgId, async (client) => {
      const inserted = await client.query<RawChannel>(
        `INSERT INTO channels (
           id, org_id, type, visibility, name, slug, topic,
           department_id, e2ee_enabled, retention_id, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, org_id, type, visibility, name, slug, topic, department_id,
                   last_seq, e2ee_enabled, retention_id, archived_at, created_by, created_at`,
        [
          channelId,
          input.orgId,
          input.type,
          input.visibility,
          input.name,
          input.slug,
          input.topic,
          input.departmentId,
          input.e2eeEnabled,
          input.retentionId,
          input.createdBy,
        ],
      );

      await client.query(
        `INSERT INTO channel_keys (channel_id, version, wrapped_dek, kek_id, is_active)
         VALUES ($1, 1, $2, $3, true)`,
        [channelId, wrappedDek, process.env.AWS_KMS_KEY_ID ?? 'local'],
      );

      // Oluşturan kişi OWNER, diğerleri MEMBER.
      const uniqueMembers = Array.from(new Set([input.createdBy, ...input.memberIds]));
      await client.query(
        `INSERT INTO channel_members (channel_id, user_id, role, invited_by)
         SELECT $1, member_id,
                CASE WHEN member_id = $2 THEN 'OWNER'::channel_member_role
                     ELSE 'MEMBER'::channel_member_role END,
                $2
           FROM unnest($3::uuid[]) AS member_id`,
        [channelId, input.createdBy, uniqueMembers],
      );

      this.logger.log({ channelId, type: input.type, members: uniqueMembers.length }, 'Kanal olusturuldu');
      return this.toRecord(inserted.rows[0]);
    });
  }

  /**
   * DM kanalını bulur veya oluşturur.
   *
   * YARIŞ KOŞULU: iki kullanıcı aynı anda birbirine yazmaya başlarsa iki
   * ayrı DM oluşabilir ve mesajlar bölünür. Çözüm şemada: `dm_key` üzerinde
   * benzersiz indeks. İkinci ekleme veritabanı seviyesinde reddedilir,
   * `ON CONFLICT` ile mevcut kanal döndürülür.
   */
  async findOrCreateDm(orgId: string, userA: string, userB: string): Promise<ChannelRecord> {
    if (userA === userB) {
      throw new ForbiddenException('Kendinizle DM olusturamazsiniz');
    }

    // Sıralama, (A,B) ve (B,A) çiftlerinin AYNI anahtarı üretmesini sağlar.
    const dmKey = createHash('sha256')
      .update([userA, userB].sort().join(':'))
      .digest();

    const existing = await this.db.withTenant(orgId, (client) =>
      client
        .query<RawChannel>(
          `SELECT id, org_id, type, visibility, name, slug, topic, department_id,
                  last_seq, e2ee_enabled, retention_id, archived_at, created_by, created_at
             FROM channels WHERE org_id = $1 AND dm_key = $2`,
          [orgId, dmKey],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (existing) return this.toRecord(existing);

    const channelId = randomUUID();
    const dek = randomBytes(32);
    let wrappedDek: Buffer;
    try {
      wrappedDek = await this.kms.wrapKey(dek);
    } finally {
      dek.fill(0);
    }

    return this.db.withTenant(orgId, async (client) => {
      const inserted = await client.query<RawChannel>(
        `INSERT INTO channels (id, org_id, type, visibility, dm_key, created_by)
         VALUES ($1, $2, 'DM', 'PRIVATE', $3, $4)
         -- Yarışı kaybeden taraf hata almaz, kazananın kanalını alır.
         -- uq_channels_dm KISMİ (partial) bir indekstir (WHERE dm_key IS
         -- NOT NULL, bkz. 001_schema.sql) -- PostgreSQL, ON CONFLICT hedef
         -- cikarimini yalnizca AYNI WHERE kosulu burada da tekrarlanirsa
         -- eslestirir; aksi halde "no unique or exclusion constraint
         -- matching" hatasiyla her DM denemesi basarisiz olur.
         ON CONFLICT (org_id, dm_key) WHERE dm_key IS NOT NULL
         DO UPDATE SET updated_at = channels.updated_at
         RETURNING id, org_id, type, visibility, name, slug, topic, department_id,
                   last_seq, e2ee_enabled, retention_id, archived_at, created_by, created_at`,
        [channelId, orgId, dmKey, userA],
      );

      const channel = this.toRecord(inserted.rows[0]);

      // Yarışı kaybettik: kanal başkası tarafından oluşturulmuş, anahtarı ve
      // üyeleri de o oluşturmuştur. Tekrar yazmaya çalışmak gereksiz.
      if (channel.id !== channelId) return channel;

      await client.query(
        `INSERT INTO channel_keys (channel_id, version, wrapped_dek, kek_id, is_active)
         VALUES ($1, 1, $2, $3, true)`,
        [channelId, wrappedDek, process.env.AWS_KMS_KEY_ID ?? 'local'],
      );

      await client.query(
        `INSERT INTO channel_members (channel_id, user_id, role)
         SELECT $1, member_id, 'MEMBER'::channel_member_role
           FROM unnest($2::uuid[]) AS member_id`,
        [channelId, [userA, userB]],
      );

      return channel;
    });
  }

  async addMembers(
    orgId: string,
    channelId: string,
    userIds: string[],
    invitedBy: string,
    role: ChannelMemberRole = ChannelMemberRole.MEMBER,
  ): Promise<number> {
    if (userIds.length === 0) return 0;

    return this.db.withTenant(orgId, async (client) => {
      const result = await client.query(
        `INSERT INTO channel_members (channel_id, user_id, role, invited_by)
         SELECT $1, member_id, $3::channel_member_role, $4
           FROM unnest($2::uuid[]) AS member_id
         -- Daha önce ayrılmış bir üye tekrar eklenirse left_at temizlenir.
         ON CONFLICT (channel_id, user_id) DO UPDATE
           SET left_at = NULL, role = EXCLUDED.role, joined_at = now()`,
        [channelId, userIds, role, invitedBy],
      );
      return result.rowCount ?? 0;
    });
  }

  /**
   * Üyeyi çıkarır — satır SİLİNMEZ, `left_at` işaretlenir.
   * Silmek, üyenin ne zaman ayrıldığı bilgisini yok eder ve denetim
   * sorularını ("bu kişi o tarihte bu kanalda mıydı?") yanıtsız bırakır.
   */
  async removeMember(orgId: string, channelId: string, userId: string): Promise<boolean> {
    return this.db.withTenant(orgId, async (client) => {
      const result = await client.query(
        `UPDATE channel_members SET left_at = now()
          WHERE channel_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [channelId, userId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async archive(orgId: string, channelId: string): Promise<boolean> {
    return this.db.withTenant(orgId, async (client) => {
      const result = await client.query(
        'UPDATE channels SET archived_at = now() WHERE id = $1 AND archived_at IS NULL',
        [channelId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  private toRecord(raw: RawChannel): ChannelRecord {
    return {
      id: raw.id,
      orgId: raw.org_id,
      type: raw.type,
      visibility: raw.visibility,
      name: raw.name,
      slug: raw.slug,
      topic: raw.topic,
      departmentId: raw.department_id,
      lastSeq: Number(raw.last_seq),
      e2eeEnabled: raw.e2ee_enabled,
      retentionId: raw.retention_id,
      archivedAt: raw.archived_at,
      createdBy: raw.created_by,
      createdAt: raw.created_at,
    };
  }
}
