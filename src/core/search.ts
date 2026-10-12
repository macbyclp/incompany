import type { Db } from '../db/client.js';

export interface SearchHit {
  id: number;
  space_id: number;
  space_name: string;
  source: string;
  conversation_id: number;
  conversation_title: string | null;
  sender_name: string | null;
  sent_at: string;
  subject: string | null;
  snippet: string;
  rank: number;
}

export interface SearchOptions {
  spaceId?: number;
  source?: 'whatsapp' | 'telegram' | 'slack' | 'email';
  limit?: number;
}

/**
 * Kullanıcının üyesi olduğu alanlarda tam metin arama yapar.
 * Erişim filtresi sorgunun içindedir; başka birinin kişisel alanı hiçbir zaman dönmez.
 */
export async function search(db: Db, userId: number, q: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const { rows } = await db.query<SearchHit>(
    `WITH q AS (SELECT websearch_to_tsquery('turkish', $2) AS tsq)
     SELECT m.id, m.space_id, s.name AS space_name, a.kind AS source,
            m.conversation_id, c.title AS conversation_title, m.sender_name,
            m.sent_at, m.subject,
            ts_headline('turkish', m.body, q.tsq,
              'StartSel=«, StopSel=», MaxWords=40, MinWords=15') AS snippet,
            ts_rank(m.tsv, q.tsq) AS rank
       FROM messages m
       JOIN q ON m.tsv @@ q.tsq
       JOIN space_members sm ON sm.space_id = m.space_id AND sm.user_id = $1
       JOIN spaces s ON s.id = m.space_id
       JOIN conversations c ON c.id = m.conversation_id
       JOIN accounts a ON a.id = c.account_id
      WHERE ($3::bigint IS NULL OR m.space_id = $3)
        AND ($4::text IS NULL OR a.kind = $4)
      ORDER BY rank DESC, m.sent_at DESC
      LIMIT $5`,
    [userId, q, opts.spaceId ?? null, opts.source ?? null, limit]);
  return rows.map((r) => ({ ...r, id: Number(r.id), space_id: Number(r.space_id),
    conversation_id: Number(r.conversation_id), rank: Number(r.rank) }));
}
