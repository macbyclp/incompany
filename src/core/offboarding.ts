import type { Db } from '../db/client.js';
import { audit } from './audit.js';
import { type AccountKind, needsConsent } from './accounts.js';

export interface OffboardOptions {
  /** 'delete': kişisel alandaki her şey silinir. 'transfer': seçilen kişiye devredilir. */
  personal: 'delete' | 'transfer';
  transferTo?: number;
}

export interface OffboardResult {
  /** Durdurulması/oturumu silinmesi gereken kişisel hesaplar. */
  stopped: Array<{ id: number; kind: AccountKind }>;
  /** Şirket botları kullanıcıdan alınıp işlemi yapan yöneticiye devredildi (çalışmaya devam eder). */
  reassignedBots: number[];
  archiveSpaceId: number | null;
  deletedMessages: number;
}

/** Hesapların bağlayıcılarını durdurmak için önce çağrılır (işlem öncesi liste). */
export async function accountsOf(db: Db, userId: number): Promise<Array<{ id: number; kind: AccountKind }>> {
  const { rows } = await db.query<{ id: number; kind: AccountKind }>(
    'SELECT id, kind FROM accounts WHERE owner_user_id = $1 ORDER BY id', [userId]);
  return rows.map((r) => ({ id: Number(r.id), kind: r.kind }));
}

/**
 * Ayrılan çalışan: kullanıcıyı devre dışı bırakır (erişim anahtarı silinir), kişisel kaynaklarını durdurur ve
 * sırlarını siler, kişisel alanını siler ya da seçilen kişiye devreder. Ortak alanlara yazılmış kayıtlar şirketin
 * hafızasında kalır. Şirket botları işlemi yapan yöneticiye geçer.
 */
export async function offboardUser(db: Db, actorId: number, userId: number, opts: OffboardOptions): Promise<OffboardResult> {
  if (userId === actorId) throw new Error('Kendi hesabınızı devre dışı bırakamazsınız');
  return db.transaction(async (tx) => {
    const target = (await tx.query<{ id: number; name: string; is_admin: boolean; disabled_at: string | null }>(
      'SELECT id, name, is_admin, disabled_at FROM users WHERE id = $1', [userId])).rows[0];
    if (!target) throw new Error('Kullanıcı bulunamadı');
    if (target.disabled_at) throw new Error('Kullanıcı zaten devre dışı');
    if (target.is_admin) {
      const others = await tx.query(
        'SELECT 1 FROM users WHERE is_admin AND disabled_at IS NULL AND id <> $1 AND token_hash IS NOT NULL LIMIT 1', [userId]);
      if (!others.rows.length) throw new Error('Son yönetici devre dışı bırakılamaz');
    }
    if (opts.personal === 'transfer') {
      const to = opts.transferTo;
      const ok = to && to !== userId
        && (await tx.query('SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL', [to])).rows.length;
      if (!ok) throw new Error('Devir için etkin bir kullanıcı seçilmeli');
    }

    const personal = (await tx.query<{ id: number }>(
      `SELECT id FROM spaces WHERE kind = 'personal' AND owner_user_id = $1`, [userId])).rows[0]!;
    const personalId = Number(personal.id);
    const accounts = (await tx.query<{ id: number; kind: AccountKind; default_space_id: number }>(
      'SELECT id, kind, default_space_id FROM accounts WHERE owner_user_id = $1', [userId])).rows
      .map((a) => ({ id: Number(a.id), kind: a.kind, default_space_id: Number(a.default_space_id) }));

    // Şirket botları (ortak alana yazan Telegram/Slack) çalışmaya devam eder; sahibi yönetici olur.
    const bots = accounts.filter((a) => !needsConsent(a.kind) && a.default_space_id !== personalId);
    for (const b of bots) await tx.query('UPDATE accounts SET owner_user_id = $2 WHERE id = $1', [b.id, actorId]);
    const stopped = accounts.filter((a) => !bots.includes(a));
    for (const a of stopped) {
      await tx.query(
        `UPDATE accounts SET enabled = false, secrets = NULL, consent_at = NULL, consent_scope = NULL,
                consent_text_version = NULL, status = 'disabled', status_at = now(),
                status_detail = 'Kullanıcı devre dışı bırakıldı' WHERE id = $1`, [a.id]);
      if (needsConsent(a.kind)) {
        await tx.query(`INSERT INTO consent_log(account_id, user_id, action, purged) VALUES ($1, $2, 'revoke', $3)`,
          [a.id, userId, opts.personal === 'delete']);
      }
    }

    let archiveSpaceId: number | null = null;
    let deletedMessages = 0;
    if (opts.personal === 'transfer') {
      const space = await tx.query<{ id: number }>(
        `INSERT INTO spaces(kind, name) VALUES ('team', $1) RETURNING id`, [`${target.name} (devredilen)`]);
      archiveSpaceId = Number(space.rows[0]!.id);
      await tx.query(`INSERT INTO space_members(space_id, user_id, role) VALUES ($1, $2, 'admin')`, [archiveSpaceId, opts.transferTo]);
      await tx.query('UPDATE conversations SET space_id = $2 WHERE space_id = $1', [personalId, archiveSpaceId]);
      await tx.query('UPDATE messages SET space_id = $2 WHERE space_id = $1', [personalId, archiveSpaceId]);
    } else {
      deletedMessages = (await tx.query('DELETE FROM messages WHERE space_id = $1 RETURNING id', [personalId])).rows.length;
      await tx.query('DELETE FROM conversations WHERE space_id = $1', [personalId]);
    }

    await tx.query('DELETE FROM space_members WHERE user_id = $1', [userId]);
    await tx.query('UPDATE users SET token_hash = NULL, disabled_at = now() WHERE id = $1', [userId]);
    await audit(tx, actorId, 'user.offboard', { type: 'user', id: userId },
      { personal: opts.personal, transfer_to: opts.transferTo ?? null, archive_space: archiveSpaceId,
        reassigned_bots: bots.length, stopped_accounts: stopped.length, deleted_messages: deletedMessages });
    return { stopped: stopped.map(({ id, kind }) => ({ id, kind })), reassignedBots: bots.map((b) => b.id), archiveSpaceId, deletedMessages };
  });
}
