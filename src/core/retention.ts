import type { Db } from '../db/client.js';
import { audit } from './audit.js';
import { getCompanyRetention } from './settings.js';

/**
 * Saklama süresi dolan mesajları siler: kişisel kaynaklarda hesabın rıza kapsamındaki retention_days,
 * şirket botlarında ayarlardaki şirket süresi geçerlidir. Günlük bir işle (ve rıza kapsamı daraldığında)
 * çalışır. Silinen mesaj sayısını döndürür.
 */
export async function purgeExpired(db: Db, opts: { now?: Date; accountId?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const company = await getCompanyRetention(db);
  const { rows } = await db.query<{ id: number }>(
    `DELETE FROM messages m USING conversations c, accounts a
      WHERE c.id = m.conversation_id AND a.id = c.account_id
        AND ($2::bigint IS NULL OR a.id = $2)
        AND (
          (a.kind IN ('whatsapp', 'email') AND (a.consent_scope->>'retention_days') IS NOT NULL
             AND m.sent_at < $1::timestamptz - ((a.consent_scope->>'retention_days')::int * interval '1 day'))
          OR (a.kind NOT IN ('whatsapp', 'email') AND $3::int IS NOT NULL
             AND m.sent_at < $1::timestamptz - ($3::int * interval '1 day'))
        )
      RETURNING m.id`, [now.toISOString(), opts.accountId ?? null, company]);
  if (rows.length) await audit(db, null, 'retention.purge', { type: 'messages' }, { deleted: rows.length });
  return rows.length;
}
