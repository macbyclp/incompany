import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import { audit } from './audit.js';

/** Telefon numaralarında varsayılan ülke kodu (Türkiye). */
const DEFAULT_COUNTRY = '90';
const PHONE_JID_DOMAINS = new Set(['s.whatsapp.net', 'c.us']);

function normalizePhone(digits: string): string {
  let d = digits.replace(/^00/, '');
  if (d.length === 11 && d.startsWith('0')) d = DEFAULT_COUNTRY + d.slice(1);
  else if (d.length === 10 && d.startsWith('5')) d = DEFAULT_COUNTRY + d;
  return d;
}

/**
 * Bir kimlik dizgesinin karşılaştırılabilir biçimleri. İlki "kanonik" olandır ve listeye
 * o saklanır. Telefon numarası (düz numara ya da WhatsApp jid'i) yalnız rakamlara indirilir;
 * e-posta ve diğer kimlikler küçük harfle olduğu gibi kalır. `@lid` kimlikleri telefon
 * numarası değildir, olduğu gibi eşleşir.
 */
export function identifierForms(raw: string | null | undefined): string[] {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return [];
  const at = s.indexOf('@');
  const domain = at >= 0 ? s.slice(at + 1) : '';
  const local = at >= 0 ? s.slice(0, at).split(':')[0]! : s;
  const compact = local.replace(/[\s()\-.]/g, '').replace(/^\+/, '');
  const phoneLike = /^\d{7,15}$/.test(compact) && (at < 0 || PHONE_JID_DOMAINS.has(domain));
  if (phoneLike) {
    const canonical = normalizePhone(compact);
    return [...new Set([canonical, s])];
  }
  return [s];
}

export const canonicalIdentifier = (raw: string): string => {
  const forms = identifierForms(raw);
  if (!forms.length) throw new Error('Kimlik boş olamaz');
  return forms[0]!;
};

/** Kimliklerden biri "beni kaydetme" listesinde mi? */
export async function isExcluded(db: Db, ids: Array<string | null | undefined>): Promise<boolean> {
  const forms = [...new Set(ids.flatMap((i) => identifierForms(i)))];
  if (!forms.length) return false;
  const { rows } = await db.query('SELECT 1 FROM exclusions WHERE value = ANY($1::text[]) LIMIT 1', [forms]);
  return rows.length > 0;
}

const likeEscape = (v: string) => v.replace(/[\\%_]/g, (c) => '\\' + c);
const overlaps = (a: string[], b: string[]) => a.some((x) => b.includes(x));

interface MatchRow {
  id: number; space_id: number; space_kind: string; space_owner: number | null; source: string;
  conversation_id: number; conv_kind: string; conv_title: string | null;
  sender_external_id: string | null; sender_name: string | null; sent_at: string; subject: string | null; body: string;
  dm_match: boolean;
}

/** Bir kişiye ait mesajlar: gönderen olarak ya da onunla yapılan birebir sohbetin parçası olarak. */
async function findPersonMessages(db: Db, identifier: string): Promise<MatchRow[]> {
  const forms = identifierForms(identifier);
  if (!forms.length) throw new Error('Kimlik boş olamaz');
  const patterns = forms.map((f) => `%${likeEscape(f)}%`);
  const { rows } = await db.query<any>(
    `SELECT m.id, m.space_id, s.kind AS space_kind, s.owner_user_id AS space_owner, a.kind AS source,
            m.conversation_id, c.kind AS conv_kind, c.title AS conv_title, c.external_id AS conv_external_id,
            m.sender_external_id, m.sender_name, m.sent_at, m.subject, m.body
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN accounts a ON a.id = c.account_id
       JOIN spaces s ON s.id = m.space_id
      WHERE lower(m.sender_external_id) LIKE ANY($1::text[])
         OR (c.kind = 'dm' AND lower(c.external_id) LIKE ANY($1::text[]))
      ORDER BY m.sent_at`, [patterns]);
  const out: MatchRow[] = [];
  for (const r of rows) {
    const senderHit = overlaps(identifierForms(r.sender_external_id), forms);
    const dmHit = r.conv_kind === 'dm' && overlaps(identifierForms(r.conv_external_id), forms);
    if (!senderHit && !dmHit) continue;
    out.push({ ...r, id: Number(r.id), space_id: Number(r.space_id), conversation_id: Number(r.conversation_id),
      space_owner: r.space_owner == null ? null : Number(r.space_owner), dm_match: dmHit });
  }
  return out;
}

const fingerprint = (identifier: string) =>
  createHash('sha256').update(canonicalIdentifier(identifier)).digest('hex').slice(0, 10);

export interface PersonExport {
  subject_ref: string;
  generated_at: string;
  messages: Array<{
    id: number; source: string; conversation: string | null; space: string; sender_name: string | null;
    sent_at: string; subject: string | null; body: string;
  }>;
  /** Erişiminiz dışındaki alanlardaki (başkasının kişisel alanı vb.) eşleşmeler: sayısı bildirilir, içeriği açılmaz. */
  hidden_by_access: number;
}

/**
 * KVKK m.11 erişim talebi. Yönetici de olsa kimse başkasının kişisel alanını okuyamaz; o alanlardaki
 * eşleşmeler yalnız sayı olarak bildirilir (silme bunları kapsar; kopya gerekirse alan sahibi kendi
 * çıktısını alır).
 */
export async function exportPersonData(
  db: Db, actorId: number, identifier: string, opts: { note?: string; asAdmin?: boolean } = {},
): Promise<PersonExport> {
  const note = opts.note;
  const rows = await findPersonMessages(db, identifier);
  const spaces = await db.query<{ id: number; name: string }>('SELECT id, name FROM spaces');
  const spaceName = new Map(spaces.rows.map((s) => [Number(s.id), s.name]));
  // Yönetici şirket ve ekip alanlarının tamamını, diğerleri yalnız üyesi olduğu alanları görür.
  const member = new Set((await db.query<{ space_id: number }>(
    'SELECT space_id FROM space_members WHERE user_id = $1', [actorId])).rows.map((r) => Number(r.space_id)));
  const visible = rows.filter((r) => r.space_kind === 'personal' ? r.space_owner === actorId
    : opts.asAdmin ? true : member.has(r.space_id));
  await audit(db, actorId, 'data.export', { type: 'person', id: fingerprint(identifier) },
    { matched: rows.length, delivered: visible.length, note: note ?? null });
  return {
    subject_ref: fingerprint(identifier),
    generated_at: new Date().toISOString(),
    messages: visible.map((r) => ({
      id: r.id, source: r.source, conversation: r.conv_title, space: spaceName.get(r.space_id) ?? `#${r.space_id}`,
      sender_name: r.sender_name, sent_at: new Date(r.sent_at).toISOString(), subject: r.subject, body: r.body,
    })),
    hidden_by_access: rows.length - visible.length,
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function personExportCsv(data: PersonExport): string {
  const head = ['id', 'kaynak', 'konuşma', 'alan', 'gönderen', 'zaman', 'konu', 'mesaj'];
  const lines = data.messages.map((m) =>
    [m.id, m.source, m.conversation, m.space, m.sender_name, m.sent_at, m.subject, m.body].map(csvCell).join(','));
  return '﻿' + [head.join(','), ...lines].join('\r\n') + '\r\n';
}

export interface ErasureResult { messages: number; conversations: number; excluded: boolean }

/**
 * KVKK m.11 silme talebi: kişinin gönderdiği tüm mesajlar ve onunla yapılan birebir sohbetler, kişisel
 * alanlar dahil her yerden silinir. exclude=true ise kişi "beni kaydetme" listesine de eklenir.
 */
export async function erasePersonData(
  db: Db, actorId: number, identifier: string, opts: { exclude?: boolean; note?: string } = {},
): Promise<ErasureResult> {
  const rows = await findPersonMessages(db, identifier);
  return db.transaction(async (tx) => {
    const messageIds = rows.map((r) => r.id);
    const dmConversations = [...new Set(rows.filter((r) => r.dm_match).map((r) => r.conversation_id))];
    if (messageIds.length) await tx.query('DELETE FROM messages WHERE id = ANY($1::bigint[])', [messageIds]);
    if (dmConversations.length) await tx.query('DELETE FROM conversations WHERE id = ANY($1::bigint[])', [dmConversations]);
    if (opts.exclude) await addExclusion(tx, actorId, identifier, { label: 'Veri silme talebi', purge: false, audit: false });
    await audit(tx, actorId, 'data.erase', { type: 'person', id: fingerprint(identifier) },
      { messages: messageIds.length, conversations: dmConversations.length, excluded: Boolean(opts.exclude), note: opts.note ?? null });
    return { messages: messageIds.length, conversations: dmConversations.length, excluded: Boolean(opts.exclude) };
  });
}

export interface Exclusion { id: number; value: string; label: string | null; created_at: string }

export async function listExclusions(db: Db): Promise<Exclusion[]> {
  const { rows } = await db.query<Exclusion>('SELECT id, value, label, created_at FROM exclusions ORDER BY id DESC');
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** Kişiyi "beni kaydetme" listesine ekler; purge=true ise geçmişte toplanan mesajları da siler. */
export async function addExclusion(
  db: Db, actorId: number, identifier: string, opts: { label?: string; purge?: boolean; audit?: boolean } = {},
): Promise<{ exclusion: Exclusion; purged: number }> {
  const value = canonicalIdentifier(identifier);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<Exclusion>(
      `INSERT INTO exclusions(value, label, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (value) DO UPDATE SET label = coalesce(EXCLUDED.label, exclusions.label)
       RETURNING id, value, label, created_at`, [value, opts.label ?? null, actorId]);
    let purged = 0;
    if (opts.purge ?? true) {
      const found = await findPersonMessages(tx, identifier);
      const ids = found.map((r) => r.id);
      if (ids.length) await tx.query('DELETE FROM messages WHERE id = ANY($1::bigint[])', [ids]);
      purged = ids.length;
    }
    if (opts.audit ?? true) await audit(tx, actorId, 'exclusion.add', { type: 'exclusion', id: rows[0]!.id }, { purged });
    return { exclusion: { ...rows[0]!, id: Number(rows[0]!.id) }, purged };
  });
}

export async function removeExclusion(db: Db, actorId: number, id: number): Promise<void> {
  const res = await db.query('DELETE FROM exclusions WHERE id = $1 RETURNING id', [id]);
  if (!res.rows.length) throw new Error('Kayıt bulunamadı');
  await audit(db, actorId, 'exclusion.remove', { type: 'exclusion', id });
}
