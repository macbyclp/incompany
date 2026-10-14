import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
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
  consent_text_version: number | null;
  last_sync_at: Date | null;
  status_at: Date | null;
}

export type CaptureMode = 'all' | 'selected' | 'none';

/** Hesap sahibinin ne topladığımıza dair seçimi. */
export interface ConsentScope {
  dm: CaptureMode;
  group: CaptureMode;
  history: boolean;
  /** Bu kadar günden eski mesajlar saklanmaz ve silinir; null/yok = süresiz. */
  retention_days?: number | null;
}

/** Bir kişinin kendi verisini içeren kaynaklar: sahibi onaylamadan çalışmaz. */
export const PERSONAL_KINDS: readonly AccountKind[] = ['whatsapp', 'email'];
export const needsConsent = (kind: AccountKind) => PERSONAL_KINDS.includes(kind);

/**
 * Anahtar halkası: `current` ile şifrelenir; `previous` yalnız eski kayıtları okumak içindir.
 * Anahtar rotasyonu: APP_SECRET'ı yenisiyle değiştir, eskisini APP_SECRET_PREVIOUS'a koy,
 * `npm run cli -- rotate-secrets` çalıştır; bittikten sonra eskisini kaldır.
 */
export interface Keyring { current: string; previous?: string[] }
export type SecretKey = string | Keyring;

const ring = (k: SecretKey): { current: string; previous: string[] } =>
  typeof k === 'string' ? { current: k, previous: [] } : { current: k.current, previous: k.previous ?? [] };

/** v1 (eski): tek SHA-256. Yalnız mevcut kayıtları okumak için tutulur. */
const legacyKey = (secret: string) => createHash('sha256').update(secret).digest();

const derived = new Map<string, Buffer>();
/** v2: scrypt ile türetilmiş anahtar (süreç başına bir kez hesaplanır). */
function keyV2(secret: string): Buffer {
  let k = derived.get(secret);
  if (!k) {
    k = scryptSync(secret, 'incompany/secrets/v2', 32, { N: 16384, r: 8, p: 1 });
    derived.set(secret, k);
  }
  return k;
}
const keyId = (secret: string) => createHash('sha256').update('kid:').update(keyV2(secret)).digest('hex').slice(0, 8);

/** AES-256-GCM; çıktı "v2.anahtarKimliği.iv.tag.şifreli" (base64url). */
export function encryptSecrets(appSecret: SecretKey, value: Record<string, string>): string {
  const { current } = ring(appSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyV2(current), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v2', keyId(current), ...[iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url'))].join('.');
}

function open(key: Buffer, iv: Buffer, tag: Buffer, enc: Buffer): Record<string, string> {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8'));
}

export function decryptSecrets(appSecret: SecretKey, blob: string): Record<string, string> {
  const { current, previous } = ring(appSecret);
  const secrets = [current, ...previous];
  const parts = blob.split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, ...rest] = parts;
    const [iv, tag, enc] = rest.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
    const match = secrets.find((s) => keyId(s) === kid);
    if (!match) throw new Error('Kaydı çözecek anahtar yok (APP_SECRET_PREVIOUS eksik olabilir)');
    return open(keyV2(match), iv, tag, enc);
  }
  const [iv, tag, enc] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
  for (const s of secrets) {
    try { return open(legacyKey(s), iv, tag, enc); } catch { /* sıradaki anahtarı dene */ }
  }
  throw new Error('Kaydı çözecek anahtar yok (APP_SECRET_PREVIOUS eksik olabilir)');
}

/** Blob güncel anahtarla v2 biçiminde şifreli değilse true. */
export function needsRotation(appSecret: SecretKey, blob: string): boolean {
  const parts = blob.split('.');
  return !(parts[0] === 'v2' && parts[1] === keyId(ring(appSecret).current));
}

/** Tüm hesap sırlarını güncel anahtarla yeniden şifreler. Okunamayan kayıt varsa işlemi iptal eder. */
export async function rotateSecrets(db: Db, appSecret: SecretKey): Promise<{ total: number; rotated: number }> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number; secrets: string }>('SELECT id, secrets FROM accounts WHERE secrets IS NOT NULL');
    let rotated = 0;
    for (const r of rows) {
      if (!needsRotation(appSecret, r.secrets)) continue;
      await tx.query('UPDATE accounts SET secrets = $2 WHERE id = $1',
        [r.id, encryptSecrets(appSecret, decryptSecrets(appSecret, r.secrets))]);
      rotated++;
    }
    return { total: rows.length, rotated };
  });
}

const cols = 'id, kind, owner_user_id, label, default_space_id, config, status, status_detail, enabled, consent_at, consent_scope, consent_text_version, last_sync_at, status_at';
const normalize = (r: any): Account => ({ ...r, id: Number(r.id),
  owner_user_id: Number(r.owner_user_id), default_space_id: Number(r.default_space_id) });

export async function createAccount(db: Db, appSecret: SecretKey, input: {
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

export async function accountSecrets(db: Db, appSecret: SecretKey, id: number): Promise<Record<string, string>> {
  const { rows } = await db.query<{ secrets: string | null }>('SELECT secrets FROM accounts WHERE id = $1', [id]);
  return rows[0]?.secrets ? decryptSecrets(appSecret, rows[0].secrets) : {};
}

/** Durumu yazar; 'connected' aynı zamanda son başarılı eşitleme anıdır. */
export async function setAccountStatus(db: Db, id: number, status: string, detail: string | null = null) {
  await db.query(
    `UPDATE accounts SET status = $2, status_detail = $3, status_at = now(),
            last_sync_at = CASE WHEN $2 = 'connected' THEN now() ELSE last_sync_at END
      WHERE id = $1`, [id, status, detail]);
}
