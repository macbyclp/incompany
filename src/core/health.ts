import type { Db } from '../db/client.js';

/** Panelde uyarı gerektiren bağlayıcı durumları. */
export const PROBLEM_STATUSES = ['error', 'logged_out', 'reconnecting'] as const;

export interface ConnectorHealth {
  ok: boolean;
  total: number;
  connected: number;
  problems: number;
  waiting: number;
}

/** Etkin hesapların özet sağlığı; kimlik ya da etiket içermez, herkese açık /health için uygundur. */
export async function connectorHealth(db: Db): Promise<ConnectorHealth> {
  const { rows } = await db.query<{ status: string; n: number }>(
    'SELECT status, count(*) AS n FROM accounts WHERE enabled GROUP BY status');
  const count = (pred: (s: string) => boolean) => rows.filter((r) => pred(r.status)).reduce((a, r) => a + Number(r.n), 0);
  const total = count(() => true);
  const connected = count((s) => s === 'connected');
  const problems = count((s) => (PROBLEM_STATUSES as readonly string[]).includes(s));
  const waiting = count((s) => ['awaiting_consent', 'awaiting_qr', 'new'].includes(s));
  return { ok: problems === 0, total, connected, problems, waiting };
}

export interface ProblemAccount {
  id: number; kind: string; label: string; owner_user_id: number; status: string;
  status_detail: string | null; status_at: string | null; last_sync_at: string | null;
}

/** Sorunlu bağlayıcıların ayrıntısı (yalnız yönetici / hesap sahibi görür). */
export async function problemAccounts(db: Db, opts: { ownerUserId?: number } = {}): Promise<ProblemAccount[]> {
  const { rows } = await db.query(
    `SELECT id, kind, label, owner_user_id, status, status_detail, status_at, last_sync_at
       FROM accounts WHERE enabled AND status = ANY($1::text[]) AND ($2::bigint IS NULL OR owner_user_id = $2)
      ORDER BY id`, [PROBLEM_STATUSES, opts.ownerUserId ?? null]);
  return rows.map((r) => ({ ...r, id: Number(r.id), owner_user_id: Number(r.owner_user_id) })) as ProblemAccount[];
}
