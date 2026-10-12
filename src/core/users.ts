import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';

export interface User {
  id: number;
  name: string;
  email: string | null;
  is_admin: boolean;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Şirket alanını yoksa oluşturur ve kimliğini döndürür. */
export async function ensureCompanySpace(db: Db, name = 'Şirket'): Promise<number> {
  const found = await db.query<{ id: number }>(`SELECT id FROM spaces WHERE kind = 'company'`);
  if (found.rows[0]) return Number(found.rows[0].id);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO spaces(kind, name) VALUES ('company', $1) RETURNING id`, [name]);
  return Number(rows[0]!.id);
}

/**
 * Kullanıcıyı, kişisel alanını ve şirket alanı üyeliğini oluşturur.
 * API token'ı yalnız burada bir kez düz metin olarak döner; veritabanında özeti durur.
 */
export async function createUser(
  db: Db, input: { name: string; email?: string; isAdmin?: boolean },
): Promise<{ user: User; token: string; personalSpaceId: number }> {
  const token = randomBytes(24).toString('base64url');
  return db.transaction(async (tx) => {
    const companyId = await ensureCompanySpace(tx);
    const { rows } = await tx.query<User>(
      `INSERT INTO users(name, email, is_admin, token_hash) VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, is_admin`,
      [input.name, input.email ?? null, input.isAdmin ?? false, hashToken(token)]);
    const user = { ...rows[0]!, id: Number(rows[0]!.id) };
    const space = await tx.query<{ id: number }>(
      `INSERT INTO spaces(kind, name, owner_user_id) VALUES ('personal', $1, $2) RETURNING id`,
      [`${input.name} (kişisel)`, user.id]);
    const personalSpaceId = Number(space.rows[0]!.id);
    await tx.query(
      `INSERT INTO space_members(space_id, user_id, role) VALUES ($1, $3, 'admin'), ($2, $3, $4)`,
      [personalSpaceId, companyId, user.id, input.isAdmin ? 'admin' : 'member']);
    return { user, token, personalSpaceId };
  });
}

export async function userByToken(db: Db, token: string): Promise<User | null> {
  const { rows } = await db.query<User>(
    'SELECT id, name, email, is_admin FROM users WHERE token_hash = $1', [hashToken(token)]);
  return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
}

export async function personalSpaceId(db: Db, userId: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM spaces WHERE kind = 'personal' AND owner_user_id = $1`, [userId]);
  if (!rows[0]) throw new Error(`Kullanıcının kişisel alanı yok: ${userId}`);
  return Number(rows[0].id);
}

export async function spaceRole(db: Db, userId: number, spaceId: number): Promise<'member' | 'admin' | null> {
  const { rows } = await db.query<{ role: 'member' | 'admin' }>(
    'SELECT role FROM space_members WHERE user_id = $1 AND space_id = $2', [userId, spaceId]);
  return rows[0]?.role ?? null;
}
