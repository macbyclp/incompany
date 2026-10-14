import type { Db } from '../db/client.js';
import { audit } from './audit.js';

export interface SpaceMember { user_id: number; name: string; email: string | null; role: 'member' | 'admin' }

async function teamSpace(db: Db, spaceId: number): Promise<{ id: number; name: string }> {
  const { rows } = await db.query<{ id: number; name: string; kind: string }>(
    'SELECT id, name, kind FROM spaces WHERE id = $1', [spaceId]);
  if (!rows[0] || rows[0].kind !== 'team') throw new Error('Ekip alanı bulunamadı');
  return { id: Number(rows[0].id), name: rows[0].name };
}

/** Ekip alanı kurar; kuran kişi alanın yöneticisi olur. */
export async function createTeamSpace(db: Db, actorId: number, name: string): Promise<{ id: number; name: string }> {
  const clean = name.trim();
  if (!clean) throw new Error('Alan adı boş olamaz');
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO spaces(kind, name) VALUES ('team', $1) RETURNING id`, [clean]);
    const id = Number(rows[0]!.id);
    await tx.query(`INSERT INTO space_members(space_id, user_id, role) VALUES ($1, $2, 'admin')`, [id, actorId]);
    await audit(tx, actorId, 'space.create', { type: 'space', id }, { name: clean });
    return { id, name: clean };
  });
}

export async function listSpaceMembers(db: Db, spaceId: number): Promise<SpaceMember[]> {
  const { rows } = await db.query(
    `SELECT sm.user_id, u.name, u.email, sm.role FROM space_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.space_id = $1 AND u.disabled_at IS NULL ORDER BY u.name`, [spaceId]);
  return rows.map((r) => ({ ...r, user_id: Number(r.user_id) })) as SpaceMember[];
}

export async function addSpaceMember(
  db: Db, actorId: number, spaceId: number, userId: number, role: 'member' | 'admin' = 'member',
): Promise<void> {
  await teamSpace(db, spaceId);
  const user = await db.query('SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL', [userId]);
  if (!user.rows.length) throw new Error('Kullanıcı bulunamadı ya da devre dışı');
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO space_members(space_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (space_id, user_id) DO UPDATE SET role = $3`, [spaceId, userId, role]);
    await audit(tx, actorId, 'space.member_add', { type: 'space', id: spaceId }, { user_id: userId, role });
  });
}

export async function removeSpaceMember(db: Db, actorId: number, spaceId: number, userId: number): Promise<void> {
  await teamSpace(db, spaceId);
  await db.transaction(async (tx) => {
    const res = await tx.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2 RETURNING user_id', [spaceId, userId]);
    if (!res.rows.length) throw new Error('Üye bulunamadı');
    await audit(tx, actorId, 'space.member_remove', { type: 'space', id: spaceId }, { user_id: userId });
  });
}
