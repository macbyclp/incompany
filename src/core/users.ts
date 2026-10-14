import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';
import { audit } from './audit.js';

export interface User {
  id: number;
  name: string;
  email: string | null;
  is_admin: boolean;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(24).toString('base64url');

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
  db: Db, input: { name: string; email?: string; isAdmin?: boolean }, actorId: number | null = null,
): Promise<{ user: User; token: string; personalSpaceId: number }> {
  const token = newToken();
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
    if (actorId !== null) await audit(tx, actorId, 'user.create', { type: 'user', id: user.id }, { admin: user.is_admin });
    return { user, token, personalSpaceId };
  });
}

/** Devre dışı bırakılmış kullanıcının anahtarı zaten silindiği için eşleşmez. */
export async function userByToken(db: Db, token: string): Promise<User | null> {
  const { rows } = await db.query<User>(
    'SELECT id, name, email, is_admin FROM users WHERE token_hash = $1 AND disabled_at IS NULL', [hashToken(token)]);
  return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
}

/** Yeni erişim anahtarı üretir; eskisi hemen geçersiz olur. Anahtar yalnız bir kez döner. */
export async function resetToken(db: Db, userId: number, actorId: number): Promise<string> {
  const token = newToken();
  const res = await db.query(
    'UPDATE users SET token_hash = $2 WHERE id = $1 AND disabled_at IS NULL RETURNING id', [userId, hashToken(token)]);
  if (!res.rows.length) throw new Error('Kullanıcı bulunamadı ya da devre dışı');
  await audit(db, actorId, userId === actorId ? 'token.rotate' : 'token.reset', { type: 'user', id: userId });
  return token;
}

/** Anahtarı iptal eder: kullanıcı yeni anahtar verilene kadar giriş yapamaz. */
export async function revokeToken(db: Db, userId: number, actorId: number): Promise<void> {
  const res = await db.query(
    'UPDATE users SET token_hash = NULL WHERE id = $1 AND disabled_at IS NULL RETURNING id', [userId]);
  if (!res.rows.length) throw new Error('Kullanıcı bulunamadı ya da devre dışı');
  await audit(db, actorId, 'token.revoke', { type: 'user', id: userId });
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

export interface UserRow extends User { created_at: string; disabled_at: string | null; accounts: number; has_token: boolean }

export async function listUsers(db: Db): Promise<UserRow[]> {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.is_admin, u.created_at, u.disabled_at, (u.token_hash IS NOT NULL) AS has_token,
            count(a.id) AS accounts
       FROM users u LEFT JOIN accounts a ON a.owner_user_id = u.id GROUP BY u.id ORDER BY u.id`);
  return rows.map((r) => ({ ...r, id: Number(r.id), accounts: Number(r.accounts) })) as UserRow[];
}
