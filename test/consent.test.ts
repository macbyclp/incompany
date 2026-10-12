import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, getAccount } from '../src/core/accounts.js';
import { grantConsent, revokeConsent, setCapture } from '../src/core/consent.js';
import { ingestMessage, type IncomingMessage } from '../src/core/ingest.js';
import { search } from '../src/core/search.js';
import { createUser, ensureCompanySpace } from '../src/core/users.js';
import { pgliteDb as testDb } from '../src/db/pglite.js';
import type { Db } from '../src/db/client.js';

let db: Db;
let ali: number, veli: number, company: number, aliPersonal: number;

const msg = (kind: 'dm' | 'group', conv: string, id: string, body: string): IncomingMessage => ({
  conversation: { externalId: conv, kind, title: conv }, externalId: id, sentAt: new Date(), body,
});

async function wa(scope?: { dm: 'all' | 'selected' | 'none'; group: 'all' | 'selected' | 'none'; history: boolean }) {
  const acc = await createAccount(db, 'x'.repeat(32), {
    kind: 'whatsapp', ownerUserId: ali, label: 'wa', defaultSpaceId: aliPersonal });
  if (scope) await grantConsent(db, acc.id, ali, scope);
  return acc;
}
const count = async () => Number((await db.query('SELECT count(*) AS n FROM messages')).rows[0]!.n);

beforeEach(async () => {
  db = await testDb();
  company = await ensureCompanySpace(db);
  const a = await createUser(db, { name: 'Ali', isAdmin: true });
  ali = a.user.id; aliPersonal = a.personalSpaceId;
  veli = (await createUser(db, { name: 'Veli' })).user.id;
});

describe('rıza', () => {
  it('rıza yokken WhatsApp mesajı hiç kaydedilmez', async () => {
    const acc = await wa();
    expect(await ingestMessage(db, acc.id, msg('dm', 'a@s', '1', 'gizli'))).toBe(false);
    expect(await count()).toBe(0);
  });

  it('kapsam açıkça seçilmeden rıza kaydedilmez', async () => {
    const acc = await wa();
    await expect(grantConsent(db, acc.id, ali, { dm: 'all' })).rejects.toThrow();
  });

  it('rızayı yalnız hesap sahibi verebilir', async () => {
    const acc = await wa();
    await expect(grantConsent(db, acc.id, veli, { dm: 'all', group: 'all', history: false })).rejects.toThrow();
    expect((await getAccount(db, acc.id))!.consent_at).toBeNull();
  });

  it('dm=selected: konuşma listelenir ama sahibi açana kadar mesaj saklanmaz', async () => {
    const acc = await wa({ dm: 'selected', group: 'none', history: false });
    expect(await ingestMessage(db, acc.id, msg('dm', 'ayse@s', '1', 'merhaba'))).toBe(false);
    expect(await count()).toBe(0);
    const conv = (await db.query<{ id: number }>('SELECT id FROM conversations')).rows[0]!;
    await setCapture(db, Number(conv.id), ali, true);
    expect(await ingestMessage(db, acc.id, msg('dm', 'ayse@s', '2', 'toplantı yarın'))).toBe(true);
    expect(await count()).toBe(1);
  });

  it('group=none: grup mesajı hiç işlenmez', async () => {
    const acc = await wa({ dm: 'all', group: 'none', history: false });
    expect(await ingestMessage(db, acc.id, msg('group', 'g@g', '1', 'aile grubu'))).toBe(false);
    expect((await db.query('SELECT 1 FROM conversations')).rows).toHaveLength(0);
  });

  it('DM yalnız sahibinin kişisel alanına düşer; başkası ve yönetici aramada görmez', async () => {
    const acc = await wa({ dm: 'all', group: 'all', history: false });
    await ingestMessage(db, acc.id, msg('dm', 'ayse@s', '1', 'maaş zammı görüşmesi'));
    expect(await search(db, ali, 'maaş')).toHaveLength(1);
    expect(await search(db, veli, 'maaş')).toHaveLength(0);
  });

  it('konuşmayı şirket alanına yalnız açıkça taşıyınca ortak aranabilir olur', async () => {
    const { moveConversation } = await import('../src/core/ingest.js');
    const acc = await wa({ dm: 'all', group: 'all', history: false });
    await ingestMessage(db, acc.id, msg('group', 'proje@g', '1', 'lansman tarihi cuma'));
    expect(await search(db, veli, 'lansman')).toHaveLength(0);
    const conv = (await db.query<{ id: number }>('SELECT id FROM conversations')).rows[0]!;
    await moveConversation(db, Number(conv.id), company);
    expect(await search(db, veli, 'lansman')).toHaveLength(1);
  });

  it('geri çekme purge ile tüm kayıtları siler ve izi consent_log içinde bırakır', async () => {
    const acc = await wa({ dm: 'all', group: 'all', history: false });
    await ingestMessage(db, acc.id, msg('dm', 'ayse@s', '1', 'merhaba'));
    await revokeConsent(db, acc.id, ali, { purge: true });
    expect(await count()).toBe(0);
    const after = (await getAccount(db, acc.id))!;
    expect(after.consent_at).toBeNull();
    expect(after.enabled).toBe(false);
    const log = (await db.query<{ action: string }>('SELECT action FROM consent_log ORDER BY id')).rows.map((r) => r.action);
    expect(log).toEqual(['grant', 'revoke']);
  });

  it('geri çekildikten sonra gelen mesaj kaydedilmez', async () => {
    const acc = await wa({ dm: 'all', group: 'all', history: false });
    await revokeConsent(db, acc.id, ali, { purge: false });
    await expect(ingestMessage(db, acc.id, msg('dm', 'ayse@s', '9', 'geç kalan'))).rejects.toThrow();
    expect(await count()).toBe(0);
  });

  it('e-posta hesabı da rıza olmadan toplanmaz; bot hesabı rıza istemez', async () => {
    const mail = await createAccount(db, 'x'.repeat(32), {
      kind: 'email', ownerUserId: ali, label: 'mail', defaultSpaceId: aliPersonal });
    const mailMsg: IncomingMessage = { conversation: { externalId: 't1', kind: 'email' }, externalId: 'm1',
      sentAt: new Date(), subject: 'Teklif', body: 'ekte' };
    expect(await ingestMessage(db, mail.id, mailMsg)).toBe(false);
    await grantConsent(db, mail.id, ali, { dm: 'none', group: 'none', history: false });
    expect(await ingestMessage(db, mail.id, mailMsg)).toBe(true);

    const bot = await createAccount(db, 'x'.repeat(32), {
      kind: 'telegram', ownerUserId: ali, label: 'bot', defaultSpaceId: company });
    expect(await ingestMessage(db, bot.id, msg('group', '-100', '1', 'sprint planı'))).toBe(true);
  });
});

