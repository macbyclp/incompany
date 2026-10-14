import type { Db } from '../db/client.js';
import { audit } from './audit.js';

export interface ConsentText { version: number; text: string }

/** Taslak metin: yayından önce bir hukuk uzmanı tarafından gözden geçirilmelidir. */
export const DEFAULT_CONSENT_TEXT = [
  'Bu sistem, bağladığınız kaynaktaki yazışmaları şirketin ortak hafızasında aranabilir hale getirir.',
  'Yalnız sizin seçtiğiniz kapsam toplanır; birebir yazışmalar ve e-postalar yalnız sizin kişisel alanınızda durur,',
  'yönetici dahil kimse göremez. Karşı tarafın mesajları da kayda girer; onları bilgilendirmek sizin sorumluluğunuzdadır.',
  'Rızanızı istediğiniz an geri çekebilir, toplanan kayıtların silinmesini isteyebilirsiniz (KVKK m.11).',
].join(' ');

const CONSENT_KEY = 'consent_text';
const RETENTION_KEY = 'company_retention_days';

export async function getConsentText(db: Db): Promise<ConsentText> {
  const { rows } = await db.query<{ value: ConsentText }>('SELECT value FROM settings WHERE key = $1', [CONSENT_KEY]);
  return rows[0]?.value ?? { version: 1, text: DEFAULT_CONSENT_TEXT };
}

/**
 * Aydınlatma metnini günceller. Metin gerçekten değiştiyse sürüm artar ve eski sürümle rıza
 * vermiş kişisel kaynaklar "rıza bekliyor"a döner; onaylanana kadar toplama durur.
 * Durdurulması gereken hesapların kimliklerini döndürür.
 */
export async function setConsentText(db: Db, actorId: number | null, text: string): Promise<{ version: number; stale: number[] }> {
  return db.transaction(async (tx) => {
    const current = await getConsentText(tx);
    const clean = text.trim();
    if (!clean) throw new Error('Metin boş olamaz');
    if (clean === current.text) return { version: current.version, stale: [] };
    const next = { version: current.version + 1, text: clean };
    await tx.query(
      `INSERT INTO settings(key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [CONSENT_KEY, JSON.stringify(next)]);
    const { rows } = await tx.query<{ id: number }>(
      `UPDATE accounts SET status = 'awaiting_consent', status_at = now(),
              status_detail = 'Aydınlatma metni güncellendi; yeniden onay gerekli'
        WHERE consent_at IS NOT NULL AND kind IN ('whatsapp', 'email')
          AND coalesce(consent_text_version, 0) < $1 RETURNING id`, [next.version]);
    await audit(tx, actorId, 'settings.consent_text', { type: 'settings', id: CONSENT_KEY },
      { version: next.version, accounts_paused: rows.length });
    return { version: next.version, stale: rows.map((r) => Number(r.id)) };
  });
}

/** Şirket botlarından (Telegram/Slack) gelen mesajlar için varsayılan saklama süresi (gün); null = süresiz. */
export async function getCompanyRetention(db: Db): Promise<number | null> {
  const { rows } = await db.query<{ value: number | null }>('SELECT value FROM settings WHERE key = $1', [RETENTION_KEY]);
  return rows[0]?.value ?? null;
}

export async function setCompanyRetention(db: Db, actorId: number | null, days: number | null): Promise<void> {
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new Error('Saklama süresi 1–3650 gün olmalı');
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO settings(key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [RETENTION_KEY, JSON.stringify(days)]);
    await audit(tx, actorId, 'settings.retention', { type: 'settings', id: RETENTION_KEY }, { days });
  });
}
