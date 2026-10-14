import { describe, expect, it } from 'vitest';
import { createAccount, getAccount } from '../src/core/accounts.js';
import { listAudit } from '../src/core/audit.js';
import { grantConsent, parseScope } from '../src/core/consent.js';
import { ingestMessage } from '../src/core/ingest.js';
import { purgeExpired } from '../src/core/retention.js';
import { getConsentText, setCompanyRetention, setConsentText } from '../src/core/settings.js';
import { count, msg, SECRET, seedPeople, useDb } from './helpers.js';

const ctx = useDb();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function waWith(scope: Record<string, unknown>) {
  const p = await seedPeople(ctx.db);
  const wa = await createAccount(ctx.db, SECRET, { kind: 'whatsapp', ownerUserId: p.veli.user.id, label: 'wa', defaultSpaceId: p.veli.personalSpaceId });
  await grantConsent(ctx.db, wa.id, p.veli.user.id, { dm: 'all', group: 'all', history: true, ...scope });
  return { ...p, wa };
}

describe('saklama süresi', () => {
  it('kapsamda doğrulanır: 1–3650 gün ya da süresiz', () => {
    expect(parseScope({ dm: 'all', group: 'all', history: false }).retention_days).toBeNull();
    expect(parseScope({ dm: 'all', group: 'all', history: false, retention_days: 30 }).retention_days).toBe(30);
    for (const bad of [0, -1, 3651, 1.5, '30']) {
      expect(() => parseScope({ dm: 'all', group: 'all', history: false, retention_days: bad }), String(bad)).toThrow();
    }
  });

  it('süresi geçmiş mesaj hiç kaydedilmez (geçmiş içe aktarmada da)', async () => {
    const s = await waWith({ retention_days: 30 });
    expect(await ingestMessage(ctx.db, s.wa.id, msg('group', 'g', '1', 'eski', { sentAt: daysAgo(31) }))).toBe(false);
    expect(await ingestMessage(ctx.db, s.wa.id, msg('group', 'g', '2', 'yeni', { sentAt: daysAgo(5) }))).toBe(true);
  });

  it('günlük iş: yalnız süresi dolan ve yalnız süre tanımlı hesabın mesajlarını siler', async () => {
    const s = await waWith({ retention_days: 30 });
    const forever = await createAccount(ctx.db, SECRET, { kind: 'whatsapp', ownerUserId: s.ayse.user.id, label: 'wa2', defaultSpaceId: s.ayse.personalSpaceId });
    await grantConsent(ctx.db, forever.id, s.ayse.user.id, { dm: 'all', group: 'all', history: true });
    // süre sonradan daraltılırken eski mesajlar zaten içeride olsun: önce süresiz kaydet
    await ctx.db.query(`UPDATE accounts SET consent_scope = consent_scope - 'retention_days' WHERE id = $1`, [s.wa.id]);
    await ingestMessage(ctx.db, s.wa.id, msg('group', 'g', '1', 'eski', { sentAt: daysAgo(40) }));
    await ingestMessage(ctx.db, s.wa.id, msg('group', 'g', '2', 'yeni', { sentAt: daysAgo(3) }));
    await ingestMessage(ctx.db, forever.id, msg('group', 'h', '3', 'süresiz eski', { sentAt: daysAgo(400) }));
    await ctx.db.query(`UPDATE accounts SET consent_scope = consent_scope || '{"retention_days":30}' WHERE id = $1`, [s.wa.id]);

    expect(await purgeExpired(ctx.db)).toBe(1);
    expect((await ctx.db.query('SELECT body FROM messages ORDER BY body')).rows.map((r: any) => r.body)).toEqual(['süresiz eski', 'yeni']);
    expect((await listAudit(ctx.db))[0]).toMatchObject({ action: 'retention.purge', actor_user_id: null });
    expect(await purgeExpired(ctx.db)).toBe(0);
  });

  it('kapsam daraltılınca süresi dolanlar hemen silinir', async () => {
    const s = await waWith({});
    await ingestMessage(ctx.db, s.wa.id, msg('group', 'g', '1', 'eski', { sentAt: daysAgo(100) }));
    await ingestMessage(ctx.db, s.wa.id, msg('group', 'g', '2', 'yeni', { sentAt: daysAgo(1) }));
    await grantConsent(ctx.db, s.wa.id, s.veli.user.id, { dm: 'all', group: 'all', history: true, retention_days: 30 });
    expect(await count(ctx.db)).toBe(1);
  });

  it('şirket botları için ayarlardaki şirket süresi geçerlidir', async () => {
    const s = await seedPeople(ctx.db);
    const tg = await createAccount(ctx.db, SECRET, { kind: 'telegram', ownerUserId: s.ali.user.id, label: 'tg', defaultSpaceId: s.company });
    await ingestMessage(ctx.db, tg.id, msg('group', 'g', '1', 'eski', { sentAt: daysAgo(200) }));
    await setCompanyRetention(ctx.db, s.ali.user.id, 90);
    expect(await ingestMessage(ctx.db, tg.id, msg('group', 'g', '2', 'çok eski', { sentAt: daysAgo(200) }))).toBe(false);
    expect(await purgeExpired(ctx.db)).toBe(1);
    await setCompanyRetention(ctx.db, s.ali.user.id, null);
    expect(await ingestMessage(ctx.db, tg.id, msg('group', 'g', '3', 'artık süresiz', { sentAt: daysAgo(200) }))).toBe(true);
    await expect(setCompanyRetention(ctx.db, s.ali.user.id, 0)).rejects.toThrow();
  });
});

describe('aydınlatma metni sürümü', () => {
  it('rıza o anki sürümle kaydedilir ve rıza günlüğüne yazılır', async () => {
    const s = await waWith({});
    expect((await getAccount(ctx.db, s.wa.id))!.consent_text_version).toBe(1);
    expect((await ctx.db.query('SELECT text_version FROM consent_log')).rows).toEqual([{ text_version: 1 }]);
  });

  it('metin değişince toplama durur, hesap "rıza bekliyor"a döner; yeniden onaylanınca devam eder', async () => {
    const s = await waWith({});
    expect(await ingestMessage(ctx.db, s.wa.id, msg('group', 'g', '1', 'önce'))).toBe(true);

    const res = await setConsentText(ctx.db, s.ali.user.id, 'Yeni ve daha ayrıntılı aydınlatma metni, saklama süresi dahil.');
    expect(res).toMatchObject({ version: 2, stale: [s.wa.id] });
    expect((await getAccount(ctx.db, s.wa.id))!.status).toBe('awaiting_consent');
    expect(await ingestMessage(ctx.db, s.wa.id, msg('group', 'g', '2', 'metin değişti, onaylanmadı'))).toBe(false);

    // eski sürümü okuyan istemcinin onayı reddedilir
    await expect(grantConsent(ctx.db, s.wa.id, s.veli.user.id, { dm: 'all', group: 'all', history: true }, { textVersion: 1 }))
      .rejects.toThrow(/Aydınlatma/);
    await grantConsent(ctx.db, s.wa.id, s.veli.user.id, { dm: 'all', group: 'all', history: true }, { textVersion: 2 });
    expect(await ingestMessage(ctx.db, s.wa.id, msg('group', 'g', '3', 'onaydan sonra'))).toBe(true);
    expect((await ctx.db.query('SELECT text_version FROM consent_log ORDER BY id')).rows).toEqual([{ text_version: 1 }, { text_version: 2 }]);
  });

  it('aynı metni kaydetmek sürümü artırmaz; boş metin reddedilir; bot hesapları etkilenmez', async () => {
    const s = await seedPeople(ctx.db);
    const tg = await createAccount(ctx.db, SECRET, { kind: 'telegram', ownerUserId: s.ali.user.id, label: 'tg', defaultSpaceId: s.company });
    const current = await getConsentText(ctx.db);
    expect(await setConsentText(ctx.db, s.ali.user.id, current.text)).toEqual({ version: 1, stale: [] });
    await expect(setConsentText(ctx.db, s.ali.user.id, '   ')).rejects.toThrow();
    await setConsentText(ctx.db, s.ali.user.id, 'Tamamen yeni bir metin yazıldı burada.');
    expect(await ingestMessage(ctx.db, tg.id, msg('group', 'g', '1', 'bot mesajı'))).toBe(true);
  });
});
