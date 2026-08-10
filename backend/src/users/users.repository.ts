import { Injectable, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GlobalRole } from '@incompany/contracts';

import { DatabaseService } from '../common/database/database.service';

export interface DirectoryUserRecord {
  id: string;
  displayName: string;
  email: string;
  title: string | null;
  avatarUrl: string | null;
}

export interface AdminUserRecord extends DirectoryUserRecord {
  status: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED';
  roles: GlobalRole[];
  lastLoginAt: Date | null;
  createdAt: Date;
}

/**
 * `users` (ve JOIN edilen `roles`/`user_roles`) RLS'lidir
 * (`tenant_isolation_users`). Bu depo (repository) SADECE `withTenant`
 * kullanır — düz `query`/`queryMaybe` kullanılırsa RLS SESSİZCE sıfır satır
 * döner (hata değil), bu da "kullanıcı eklendi ama listede yok" gibi
 * teşhisi zor hatalara yol açar. Bu sınıfın kod tabanındaki gerçek bir
 * örneği için bkz. `auth.service.ts` / `channel.repository.ts` yorumları.
 */
@Injectable()
export class UsersRepository {
  constructor(private readonly db: DatabaseService) {}

  async listForOrg(orgId: string): Promise<DirectoryUserRecord[]> {
    return this.db.withTenant(orgId, (client) =>
      client
        .query<{ id: string; display_name: string; email: string; title: string | null; avatar_url: string | null }>(
          `SELECT id, display_name, email, title, avatar_url
             FROM users
            WHERE org_id = $1 AND deleted_at IS NULL AND status = 'ACTIVE'
            ORDER BY display_name`,
          [orgId],
        )
        .then((r) => r.rows.map(this.toDirectoryRecord)),
    );
  }

  async resolveByIds(orgId: string, ids: string[]): Promise<DirectoryUserRecord[]> {
    if (ids.length === 0) return [];

    return this.db.withTenant(orgId, (client) =>
      client
        .query<{ id: string; display_name: string; email: string; title: string | null; avatar_url: string | null }>(
          `SELECT id, display_name, email, title, avatar_url
             FROM users
            WHERE org_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
          [orgId, ids],
        )
        .then((r) => r.rows.map(this.toDirectoryRecord)),
    );
  }

  async listForAdmin(orgId: string): Promise<AdminUserRecord[]> {
    return this.db.withTenant(orgId, (client) =>
      client
        .query<{
          id: string;
          display_name: string;
          email: string;
          title: string | null;
          avatar_url: string | null;
          status: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED';
          last_login_at: Date | null;
          created_at: Date;
          roles: string[] | null;
        }>(
          // `roles.key` `citext`tir — `array_agg` `::text` cast'i olmadan
          // pg sürücüsünde ham metne düşer (bkz. auth.service.ts USER_AUTH_QUERY
          // yorumu, gerçek DB'ye karşı ilk çalıştırmada bulunan JWT bozulma hatası).
          `SELECT u.id, u.display_name, u.email, u.title, u.avatar_url,
                  u.status, u.last_login_at, u.created_at,
                  array_agg(DISTINCT r.key::text) FILTER (WHERE r.key IS NOT NULL) AS roles
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id AND (ur.expires_at IS NULL OR ur.expires_at > now())
             LEFT JOIN roles r ON r.id = ur.role_id
            WHERE u.org_id = $1 AND u.deleted_at IS NULL
            GROUP BY u.id
            ORDER BY u.display_name`,
          [orgId],
        )
        .then((r) =>
          r.rows.map((row) => ({
            ...this.toDirectoryRecord(row),
            status: row.status,
            roles: (row.roles ?? []) as GlobalRole[],
            lastLoginAt: row.last_login_at,
            createdAt: row.created_at,
          })),
        ),
    );
  }

  /**
   * Yeni kullanıcı provizyonu (yönetim panelinden).
   *
   * Bu dağıtım parola tabanlı girişi de destekler (bkz. `AuthService.
   * loginWithPassword`) — SSO her zaman yapılandırılmış olmayabilir. Bu
   * yüzden burada `idp_subject` bağlamak yerine RASTGELE bir geçici parola
   * üretilir ve tek seferlik olarak döndürülür: yönetici bunu kullanıcıya
   * iletir. Kullanıcı ilk girişte parolasını değiştirmeye ZORLANMAZ (henüz
   * o akış yok) — bilinen bir sınırlamadır.
   */
  async createProvisioned(
    orgId: string,
    input: { displayName: string; email: string; title: string | null; roles: GlobalRole[] },
    passwordHash: string,
  ): Promise<{ id: string }> {
    return this.db.withTenant(orgId, async (client) => {
      const existing = await client.query(
        'SELECT 1 FROM users WHERE org_id = $1 AND email = $2',
        [orgId, input.email],
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException('Bu e-posta ile bir kullanici zaten var');
      }

      const userId = randomUUID();
      await client.query(
        `INSERT INTO users (id, org_id, email, display_name, title, password_hash, status, token_version)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',0)`,
        [userId, orgId, input.email.toLowerCase(), input.displayName, input.title, passwordHash],
      );

      for (const roleKey of input.roles) {
        const role = await client.query<{ id: string }>(
          'SELECT id FROM roles WHERE key = $1 AND org_id IS NULL',
          [roleKey],
        );
        if (role.rowCount === 0) continue;
        await client.query(
          'INSERT INTO user_roles (id, user_id, role_id) VALUES ($1,$2,$3)',
          [randomUUID(), userId, role.rows[0].id],
        );
      }

      return { id: userId };
    });
  }

  async updateProfile(
    orgId: string,
    userId: string,
    patch: { displayName?: string; title?: string | null },
  ): Promise<void> {
    await this.db.withTenant(orgId, (client) =>
      client.query(
        `UPDATE users
            SET display_name = COALESCE($3, display_name),
                title = CASE WHEN $4 THEN $5 ELSE title END
          WHERE id = $1 AND org_id = $2`,
        [userId, orgId, patch.displayName ?? null, 'title' in patch, patch.title ?? null],
      ),
    );
  }

  /** Yönetim paneli: durum ve/veya rol güncelleme (mevcut roller değiştirilir). */
  async adminUpdate(
    orgId: string,
    userId: string,
    patch: { status?: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED'; roles?: GlobalRole[] },
  ): Promise<void> {
    await this.db.withTenant(orgId, async (client) => {
      if (patch.status) {
        await client.query('UPDATE users SET status = $3 WHERE id = $1 AND org_id = $2', [
          userId,
          orgId,
          patch.status,
        ]);
      }

      if (patch.roles) {
        await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
        for (const roleKey of patch.roles) {
          const role = await client.query<{ id: string }>(
            'SELECT id FROM roles WHERE key = $1 AND org_id IS NULL',
            [roleKey],
          );
          if (role.rowCount === 0) continue;
          await client.query(
            'INSERT INTO user_roles (id, user_id, role_id) VALUES ($1,$2,$3)',
            [randomUUID(), userId, role.rows[0].id],
          );
        }
      }
    });
  }

  private toDirectoryRecord(row: {
    id: string;
    display_name: string;
    email: string;
    title: string | null;
    avatar_url: string | null;
  }): DirectoryUserRecord {
    return {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      title: row.title,
      avatarUrl: row.avatar_url,
    };
  }
}
