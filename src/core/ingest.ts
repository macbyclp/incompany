import type { Db } from '../db/client.js';
import { needsConsent, type AccountKind, type CaptureMode, type ConsentScope } from './accounts.js';
import { isExcluded } from './privacy.js';
import { personalSpaceId } from './users.js';

export type ConversationKind = 'dm' | 'group' | 'channel' | 'email';

/** Her bağlayıcının ürettiği ortak biçim. */
export interface IncomingMessage {
  conversation: { externalId: string; kind: ConversationKind; title?: string | null };
  externalId: string;
  senderExternalId?: string | null;
  senderName?: string | null;
  fromMe?: boolean;
  sentAt: Date;
  subject?: string | null;
  body: string;
  raw?: unknown;
  /** true: kaynakta düzenlenmiş mesaj; kayıtlı içerik yerinde güncellenir (önceki sürüm saklanmaz). */
  edit?: boolean;
  /**
   * Konuşmanın diğer tarafları (ör. e-posta alıcıları). Hesap sahibinin kendi gönderdiği bir
   * mesajda bunlardan biri "beni kaydetme" listesindeyse mesaj kaydedilmez.
   */
  counterparts?: string[];
}

interface AccountRow {
  id: number;
  kind: AccountKind;
  owner_user_id: number;
  default_space_id: number;
  consent_at: Date | null;
  consent_scope: ConsentScope | null;
  consent_text_version: number | null;
  /** Güncel aydınlatma metni sürümü (settings); kayıt yoksa 1. */
  text_version: number | null;
  /** Şirket botları için varsayılan saklama süresi (gün). */
  company_retention: number | null;
}

/**
 * Bu konuşma türü için hesap sahibinin verdiği izin. Kişisel kaynaklarda rıza yoksa ya da rıza
 * eski bir aydınlatma metni sürümüne verilmişse 'none': bağlayıcı yanlışlıkla çalışsa bile
 * hiçbir şey yazılmaz. Botlar (Telegram/Slack) şirket kaynağıdır; bir kişinin hesabı olmadığı için
 * kapsam sormaz.
 */
export function captureMode(
  account: Pick<AccountRow, 'kind' | 'consent_at' | 'consent_scope' | 'consent_text_version'>,
  kind: ConversationKind, currentTextVersion?: number,
): CaptureMode {
  if (!needsConsent(account.kind)) return 'all';
  if (!account.consent_at || !account.consent_scope) return 'none';
  if (currentTextVersion !== undefined && (account.consent_text_version ?? 0) !== currentTextVersion) return 'none';
  if (kind === 'email') return 'all';
  return kind === 'dm' ? account.consent_scope.dm : account.consent_scope.group;
}

/** Bu hesap için geçerli saklama süresi (gün); null = süresiz. */
export function retentionDays(account: Pick<AccountRow, 'kind' | 'consent_scope' | 'company_retention'>): number | null {
  if (needsConsent(account.kind)) return account.consent_scope?.retention_days ?? null;
  return account.company_retention ?? null;
}

/**
 * Yeni bir konuşmanın hangi alana yazılacağını belirler.
 * Birebir yazışmalar ve e-postalar her zaman hesap sahibinin kişisel alanına gider;
 * gruplar ve kanallar hesabın varsayılan alanına. Bir konuşma ancak sonradan
 * moveConversation ile açıkça başka bir alana taşınabilir.
 */
async function initialSpace(db: Db, account: AccountRow, kind: ConversationKind): Promise<number> {
  if (kind === 'dm' || kind === 'email') return personalSpaceId(db, Number(account.owner_user_id));
  return Number(account.default_space_id);
}

/** Mesajı kaydeder. Aynı mesaj ikinci kez gelirse yok sayılır ve false döner. */
export async function ingestMessage(db: Db, accountId: number, msg: IncomingMessage): Promise<boolean> {
  const body = msg.body.trim();
  if (!body && !msg.subject) return false;

  return db.transaction(async (tx) => {
    const acc = await tx.query<AccountRow>(
      `SELECT id, kind, owner_user_id, default_space_id, consent_at, consent_scope, consent_text_version,
              coalesce((SELECT (value->>'version')::int FROM settings WHERE key = 'consent_text'), 1) AS text_version,
              (SELECT (value #>> '{}')::int FROM settings WHERE key = 'company_retention_days') AS company_retention
         FROM accounts WHERE id = $1 AND enabled`, [accountId]);
    const account = acc.rows[0];
    if (!account) throw new Error(`Hesap bulunamadı ya da kapalı: ${accountId}`);

    const mode = captureMode(account, msg.conversation.kind, Number(account.text_version ?? 1));
    if (mode === 'none') return false;

    // "Beni kaydetme" listesi: gönderen, birebir sohbetin karşı tarafı ya da (kendi mesajımda) alıcılar.
    if (await isExcluded(tx, [
      msg.senderExternalId,
      msg.conversation.kind === 'dm' ? msg.conversation.externalId : null,
      ...(msg.fromMe ? msg.counterparts ?? [] : []),
    ])) return false;

    const days = retentionDays({ ...account, company_retention: account.company_retention == null ? null : Number(account.company_retention) });
    if (days !== null && msg.sentAt.getTime() < Date.now() - days * 86_400_000) return false;

    let conv = await tx.query<{ id: number; space_id: number; title: string | null; capture: boolean }>(
      'SELECT id, space_id, title, capture FROM conversations WHERE account_id = $1 AND external_id = $2',
      [accountId, msg.conversation.externalId]);
    if (!conv.rows[0]) {
      const spaceId = await initialSpace(tx, account, msg.conversation.kind);
      // 'selected' kipinde konuşma yalnız başlığıyla listelenir; sahibi açana kadar mesaj saklanmaz.
      conv = await tx.query(
        `INSERT INTO conversations(account_id, external_id, kind, title, space_id, capture)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id, external_id) DO UPDATE SET title = conversations.title
         RETURNING id, space_id, title, capture`,
        [accountId, msg.conversation.externalId, msg.conversation.kind,
          msg.conversation.title ?? null, spaceId, mode === 'all']);
    } else if (msg.conversation.title && msg.conversation.title !== conv.rows[0].title) {
      await tx.query('UPDATE conversations SET title = $1 WHERE id = $2',
        [msg.conversation.title, conv.rows[0].id]);
    }
    const { id: conversationId, space_id: spaceId, capture } = conv.rows[0]!;
    if (!capture) return false;

    const raw = msg.raw === undefined ? null : JSON.stringify(msg.raw);
    let stored = false;
    if (msg.edit) {
      const updated = await tx.query(
        `UPDATE messages SET body = $3, subject = $4, raw = $5, edited_at = now()
          WHERE conversation_id = $1 AND external_id = $2 RETURNING id`,
        [conversationId, msg.externalId, body, msg.subject ?? null, raw]);
      stored = updated.rows.length > 0;
    }
    if (!stored) {
      const inserted = await tx.query(
        `INSERT INTO messages(conversation_id, space_id, external_id, sender_external_id,
           sender_name, from_me, sent_at, subject, body, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (conversation_id, external_id) DO NOTHING
         RETURNING id`,
        [conversationId, spaceId, msg.externalId, msg.senderExternalId ?? null,
          msg.senderName ?? null, msg.fromMe ?? false, msg.sentAt, msg.subject ?? null, body, raw]);
      stored = inserted.rows.length > 0;
    }
    if (stored) {
      // Son başarılı eşitleme anı; her mesajda yazmamak için dakikada en fazla bir kez.
      await tx.query(
        `UPDATE accounts SET last_sync_at = now()
          WHERE id = $1 AND (last_sync_at IS NULL OR last_sync_at < now() - interval '1 minute')`, [accountId]);
    }
    return stored;
  });
}

/** Kaynakta silinen mesajı burada da siler. Kayıt varsa true döner. */
export async function deleteIncomingMessage(
  db: Db, accountId: number, conversationExternalId: string, messageExternalId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `DELETE FROM messages m USING conversations c
      WHERE c.id = m.conversation_id AND c.account_id = $1 AND c.external_id = $2 AND m.external_id = $3
      RETURNING m.id`, [accountId, conversationExternalId, messageExternalId]);
  return rows.length > 0;
}

/** Konuşmayı geçmişiyle birlikte başka bir alana taşır (ör. bir grubu şirket hafızasına açmak). */
export async function moveConversation(db: Db, conversationId: number, spaceId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const res = await tx.query('UPDATE conversations SET space_id = $1 WHERE id = $2 RETURNING id',
      [spaceId, conversationId]);
    if (!res.rows.length) throw new Error(`Konuşma bulunamadı: ${conversationId}`);
    await tx.query('UPDATE messages SET space_id = $1 WHERE conversation_id = $2', [spaceId, conversationId]);
  });
}
