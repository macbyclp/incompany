import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';

export type AccountKind = 'whatsapp' | 'telegram' | 'slack' | 'email';

export interface Account {
  id: number;
  kind: AccountKind;
  owner_user_id: number;
  label: string;
  default_space_id: number;
  config: Record<string, any>;
  status: string;
  status_detail: string | null;
  enabled: boolean;
  consent_at: Date | null;
  consent_scope: ConsentScope | null;
}

export type CaptureMode = 'all' | 'selected' | 'none';

/** Hesap sahibinin ne topladığımıza dair seçimi. */
export interface ConsentScope { dm: CaptureMode; group: CaptureMode; history: boolean }

/** Bir kişinin kendi verisini içeren kaynaklar: sahibi onaylamadan çalışmaz. */
export const PERSONAL_KINDS: readonly AccountKind[] = ['whatsapp', 'email'];
export const needsConsent = (kind: AccountKind) => PERSONAL_KINDS.includes(kind);

const key = (appSecret: string) => createHash('sha256').update(appSecret).digest();

/** AES-256-GCM; çıktı "iv.tag.şifreli" biçiminde base64url. */
export function encryptSecrets(appSecret: string, value: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(appSecret), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecrets(appSecret: string, blob: string): Record<string, string> {
  const [iv, tag, enc] = blob.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(appSecret), iv!);
  decipher.setAuthTag(tag!);
  return JSON.parse(Buffer.concat([decipher.update(enc!), decipher.final()]).toString('utf8'));
}

const cols = 'id, kind, owner_user_id, label, default_space_id, config, status, status_detail, enabled, consent_at, consent_scope';
const normalize = (r: any): Account => ({ ...r, id: Number(r.id),
  owner_user_id: Number(r.owner_user_id), default_space_id: Number(r.default_space_id) });

export async function createAccount(db: Db, appSecret: string, input: {
  kind: AccountKind; ownerUserId: number; label: string; defaultSpaceId: number;
  config?: Record<string, any>; secrets?: Record<string, string>;
}): Promise<Account> {
  const { rows } = await db.query(
    `INSERT INTO accounts(kind, owner_user_id, label, default_space_id, config, secrets)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${cols}`,
    [input.kind, input.ownerUserId, input.label, input.defaultSpaceId,
      JSON.stringify(input.config ?? {}),
      input.secrets ? encryptSecrets(appSecret, input.secrets) : null]);
  return normalize(rows[0]);
}

export async function getAccount(db: Db, id: number): Promise<Account | null> {
  const { rows } = await db.query(`SELECT ${cols} FROM accounts WHERE id = $1`, [id]);
  return rows[0] ? normalize(rows[0]) : null;
}

export async function listAccounts(db: Db, filter: { ownerUserId?: number; enabled?: boolean } = {}): Promise<Account[]> {
  const { rows } = await db.query(
    `SELECT ${cols} FROM accounts
      WHERE ($1::bigint IS NULL OR owner_user_id = $1) AND ($2::boolean IS NULL OR enabled = $2)
      ORDER BY id`,
    [filter.ownerUserId ?? null, filter.enabled ?? null]);
  return rows.map(normalize);
}

export async function accountSecrets(db: Db, appSecret: string, id: number): Promise<Record<string, string>> {
  const { rows } = await db.query<{ secrets: string | null }>('SELECT secrets FROM accounts WHERE id = $1', [id]);
  return rows[0]?.secrets ? decryptSecrets(appSecret, rows[0].secrets) : {};
}

export async function setAccountStatus(db: Db, id: number, status: string, detail: string | null = null) {
  await db.query('UPDATE accounts SET status = $2, status_detail = $3 WHERE id = $1', [id, status, detail]);
}
