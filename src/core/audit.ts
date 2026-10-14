import type { Db } from '../db/client.js';

export interface AuditEntry {
  id: number;
  actor_user_id: number | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  at: string;
}

/**
 * Yönetici işlemlerinin izi. İçerik değil, yalnız kim/ne/ne zaman tutulur; kişisel veri
 * (mesaj gövdesi, tam kimlik) buraya yazılmaz.
 */
export async function audit(
  db: Db, actorId: number | null, action: string,
  target?: { type?: string; id?: string | number }, detail?: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log(actor_user_id, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5)`,
    [actorId, action, target?.type ?? null, target?.id === undefined ? null : String(target.id),
      detail ? JSON.stringify(detail) : null]);
}

export async function listAudit(db: Db, opts: { limit?: number; before?: number } = {}): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { rows } = await db.query(
    `SELECT l.id, l.actor_user_id, u.name AS actor_name, l.action, l.target_type, l.target_id, l.detail, l.at
       FROM audit_log l LEFT JOIN users u ON u.id = l.actor_user_id
      WHERE ($1::bigint IS NULL OR l.id < $1) ORDER BY l.id DESC LIMIT $2`, [opts.before ?? null, limit]);
  return rows.map((r) => ({ ...r, id: Number(r.id), actor_user_id: r.actor_user_id == null ? null : Number(r.actor_user_id) })) as AuditEntry[];
}
