import { Controller, Get } from '@nestjs/common';

import { DatabaseService } from '../common/database/database.service';
import { CurrentUser } from '../auth/decorators';
import type { AuthenticatedUser } from '../auth/auth.types';

/**
 * Departman listesi — salt okunur.
 *
 * Önceden frontend (`AdminDialog.tsx` → `DepartmentsPanel`) tamamen sabit
 * kodlanmış (hardcoded) örnek veriler gösteriyordu ("Bilgi Teknolojileri",
 * "Can Demir" vb.) — hiçbir zaman bu uç noktayı çağırmıyordu çünkü bu uç
 * nokta hiç yoktu. `departments` tablosu şemada zaten vardı, yalnızca
 * okuma API'si eksikti.
 */
@Controller({ path: 'departments', version: '1' })
export class DepartmentsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    // `departments` RLS'li değildir (yalnızca users/channels/messages/
    // audit_logs/attachments'ta `tenant_isolation_*` var, bkz.
    // 001_schema.sql) — ama `manager_id`/üye sayımı `users`'a JOIN eder,
    // o RLS'lidir. Bu yüzden yine de `withTenant` kullanılır.
    const rows = await this.db.withTenant(user.orgId, (client) =>
      client
        .query<{
          id: string;
          name: string;
          code: string;
          member_count: string;
          manager_name: string | null;
        }>(
          `SELECT d.id, d.name, d.code,
                  (SELECT count(*) FROM users u WHERE u.department_id = d.id AND u.deleted_at IS NULL) AS member_count,
                  m.display_name AS manager_name
             FROM departments d
             LEFT JOIN users m ON m.id = d.manager_id
            WHERE d.org_id = $1 AND d.is_active = true
            ORDER BY d.name`,
          [user.orgId],
        )
        .then((r) => r.rows),
    );

    return {
      departments: rows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        memberCount: Number(r.member_count),
        managerName: r.manager_name,
      })),
    };
  }
}
