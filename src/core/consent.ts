import { rm } from 'node:fs/promises';
import { getAccount, needsConsent, type Account, type CaptureMode, type ConsentScope } from './accounts.js';
import type { Db } from '../db/client.js';

const MODES: CaptureMode[] = ['all', 'selected', 'none'];

export function parseScope(raw: any): ConsentScope {
  if (!raw || !MODES.includes(raw.dm) || !MODES.includes(raw.group) || typeof raw.history !== 'boolean') {
    throw new Error('Kapsam eksik: dm, group (all|selected|none) ve history (true|false) açıkça seçilmeli');
  }
  return { dm: raw.dm, group: raw.group, history: raw.history };
}

/** Rıza yalnız hesabın sahibi tarafından verilir; yönetici bile onun yerine veremez. */
function assertOwner(account: Account | null, userId: number): Account {
  if (!account || account.owner_user_id !== userId) throw new Error('Hesap bulunamadı');
  return account;
}

export async function grantConsent(db: Db, accountId: number, userId: number, rawScope: unknown): Promise<Account> {
  const scope = parseScope(rawScope);
  await db.transaction(async (tx) => {
    const account = assertOwner(await getAccount(tx, accountId), userId);
    if (!needsConsent(account.kind)) throw new Error('Bu kaynak türü kişisel rıza gerektirmiyor');
    const action = account.consent_at ? 'scope_change' : 'grant';
    await tx.query(
      `UPDATE accounts SET consent_at = coalesce(consent_at, now()), consent_scope = $2 WHERE id = $1`,
      [accountId, JSON.stringify(scope)]);
    // Kapsam daraldıysa o türdeki konuşmalar yeni mesaj almayı bırakır (eski kayıt silinmez; silmek ayrı karar).
    if (scope.dm === 'none') await tx.query(
      `UPDATE conversations SET capture = false WHERE account_id = $1 AND kind = 'dm'`, [accountId]);
    if (scope.group === 'none') await tx.query(
      `UPDATE conversations SET capture = false WHERE account_id = $1 AND kind IN ('group', 'channel')`, [accountId]);
    await tx.query(
      `INSERT INTO consent_log(account_id, user_id, action, scope) VALUES ($1, $2, $3, $4)`,
      [accountId, userId, action, JSON.stringify(scope)]);
  });
  return (await getAccount(db, accountId))!;
}

/**
 * Rızayı geri çeker: hesap durur ve devre dışı kalır. purge=true ise o hesaptan gelen tüm
 * konuşmalar ve mesajlar silinir; purge=false ise kayıtlar kalır (sahibi bilerek seçmelidir).
 * Oturum dosyaları (WhatsApp anahtarları) her durumda silinir. Silinecek klasörü çağıran verir.
 */
export async function revokeConsent(
  db: Db, accountId: number, userId: number, opts: { purge: boolean; sessionDir?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    assertOwner(await getAccount(tx, accountId), userId);
    await tx.query(
      `UPDATE accounts SET consent_at = NULL, consent_scope = NULL, enabled = false,
              status = 'revoked', status_detail = NULL, secrets = NULL WHERE id = $1`, [accountId]);
    if (opts.purge) await tx.query('DELETE FROM conversations WHERE account_id = $1', [accountId]);
    await tx.query(
      `INSERT INTO consent_log(account_id, user_id, action, purged) VALUES ($1, $2, 'revoke', $3)`,
      [accountId, userId, opts.purge]);
  });
  if (opts.sessionDir) await rm(opts.sessionDir, { recursive: true, force: true });
}

/** Sahibinin bir konuşmayı toplamaya açması/kapatması ("selected" kipinin düğmesi). */
export async function setCapture(
  db: Db, conversationId: number, userId: number, capture: boolean, purgeExisting = false,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number }>(
      `SELECT c.id FROM conversations c JOIN accounts a ON a.id = c.account_id
        WHERE c.id = $1 AND a.owner_user_id = $2`, [conversationId, userId]);
    if (!rows[0]) throw new Error('Konuşma bulunamadı');
    await tx.query('UPDATE conversations SET capture = $2 WHERE id = $1', [conversationId, capture]);
    if (!capture && purgeExisting) await tx.query('DELETE FROM messages WHERE conversation_id = $1', [conversationId]);
  });
}
