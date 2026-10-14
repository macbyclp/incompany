import { describe, expect, it } from 'vitest';
import { createAccount } from '../src/core/accounts.js';
import { listAudit } from '../src/core/audit.js';
import { grantConsent } from '../src/core/consent.js';
import { ingestMessage } from '../src/core/ingest.js';
import {
  addExclusion, canonicalIdentifier, erasePersonData, exportPersonData, identifierForms, isExcluded,
  listExclusions, personExportCsv, removeExclusion,
} from '../src/core/privacy.js';
import { count, msg, SECRET, seedPeople, useDb } from './helpers.js';

const ctx = useDb();

describe('identifierForms', () => {
  it('telefon: biçimden bağımsız aynı kanonik değer', () => {
    const want = '905551112233';
    for (const raw of ['+90 555 111 22 33', '0555 111 22 33', '905551112233', '(0555) 111-22-33', '5551112233',
      '905551112233@s.whatsapp.net', '905551112233:12@s.whatsapp.net', '905551112233@c.us']) {
      expect(identifierForms(raw)[0], raw).toBe(want);
    }
  });
  it('e-posta, LID ve düz kimlikler olduğu gibi (küçük harf); rakamdan oluşan e-posta yerel kısmı telefon sayılmaz', () => {
    expect(identifierForms(' Ayse@Firma.com ')).toEqual(['ayse@firma.com']);
    expect(identifierForms('12345678@firma.com')).toEqual(['12345678@firma.com']);
    expect(identifierForms('99887766@lid')).toEqual(['99887766@lid']);
    expect(identifierForms('')).toEqual([]);
    expect(() => canonicalIdentifier('  ')).toThrow();
  });
});

async function setup() {
  const p = await seedPeople(ctx.db);
  const tg = await createAccount(ctx.db, SECRET, { kind: 'telegram', ownerUserId: p.ali.user.id, label: 'tg', defaultSpaceId: p.company });
  const wa = await createAccount(ctx.db, SECRET, { kind: 'whatsapp', ownerUserId: p.veli.user.id, label: 'wa', defaultSpaceId: p.veli.personalSpaceId });
  await grantConsent(ctx.db, wa.id, p.veli.user.id, { dm: 'all', group: 'all', history: false });
  const mail = await createAccount(ctx.db, SECRET, { kind: 'email', ownerUserId: p.veli.user.id, label: 'm', defaultSpaceId: p.veli.personalSpaceId, config: {}, secrets: { password: 'x' } });
  await grantConsent(ctx.db, mail.id, p.veli.user.id, { dm: 'none', group: 'none', history: false });
  return { ...p, tg, wa, mail };
}

describe('"beni kaydetme" listesi', () => {
  it('hariç tutulan kişinin mesajı hiçbir kaynaktan kaydedilmez', async () => {
    const s = await setup();
    await addExclusion(ctx.db, s.ali.user.id, '+90 555 111 22 33', { label: 'Zeynep' });
    const jid = '905551112233@s.whatsapp.net';
    // WhatsApp grubu (gönderen jid), WhatsApp DM (sohbet kimliği), Telegram (kullanıcı kimliği), e-posta (gönderen)
    expect(await ingestMessage(ctx.db, s.wa.id, msg('group', 'g@g.us', '1', 'grup', { senderExternalId: jid }))).toBe(false);
    expect(await ingestMessage(ctx.db, s.wa.id, msg('dm', jid, '2', 'dm gelen', { senderExternalId: jid }))).toBe(false);
    expect(await ingestMessage(ctx.db, s.wa.id, msg('dm', jid, '3', 'dm benim', { fromMe: true }))).toBe(false);
    expect(await ingestMessage(ctx.db, s.tg.id, msg('group', 'tg', '4', 'telegram', { senderExternalId: '905551112233' }))).toBe(false);
    await addExclusion(ctx.db, s.ali.user.id, 'Sahte@Firma.com');
    expect(await ingestMessage(ctx.db, s.mail.id, msg('email', '<t>', '5', 'posta', { senderExternalId: 'sahte@firma.com' }))).toBe(false);
    expect(await count(ctx.db)).toBe(0);
  });

  it('başkalarının mesajı etkilenmez; listeden çıkarılınca toplama yeniden başlar', async () => {
    const s = await setup();
    const { exclusion } = await addExclusion(ctx.db, s.ali.user.id, '905551112233');
    expect(await ingestMessage(ctx.db, s.wa.id, msg('group', 'g@g.us', '1', 'başka kişi', { senderExternalId: '905559998877@s.whatsapp.net' }))).toBe(true);
    expect(await isExcluded(ctx.db, ['905559998877@s.whatsapp.net'])).toBe(false);
    await removeExclusion(ctx.db, s.ali.user.id, exclusion.id);
    expect(await ingestMessage(ctx.db, s.wa.id, msg('group', 'g@g.us', '2', 'artık serbest', { senderExternalId: '905551112233@s.whatsapp.net' }))).toBe(true);
  });

  it('kendi gönderdiğim e-posta alıcılarından biri hariç tutulmuşsa kaydedilmez; gelen e-postadaki cc etkilemez', async () => {
    const s = await setup();
    await addExclusion(ctx.db, s.ali.user.id, 'zeynep@tedarik.com');
    const out = msg('email', '<a>', '1', 'giden', { fromMe: true, senderExternalId: 'veli@sirket.com', counterparts: ['x@y.com', 'Zeynep@Tedarik.com'] });
    expect(await ingestMessage(ctx.db, s.mail.id, out)).toBe(false);
    const incoming = msg('email', '<b>', '2', 'gelen', { senderExternalId: 'musteri@y.com', counterparts: ['zeynep@tedarik.com'] });
    expect(await ingestMessage(ctx.db, s.mail.id, incoming)).toBe(true);
  });

  it('listeye eklerken geçmişte toplananlar silinir (purge=false ise kalır)', async () => {
    const s = await setup();
    const from = (n: string) => msg('group', 'g@g.us', n, 'x', { senderExternalId: '905551112233@s.whatsapp.net' });
    await ingestMessage(ctx.db, s.wa.id, from('1'));
    await ingestMessage(ctx.db, s.wa.id, msg('group', 'g@g.us', '2', 'başkası', { senderExternalId: '905550000000@s.whatsapp.net' }));
    expect((await addExclusion(ctx.db, s.ali.user.id, '905551112233', { purge: false })).purged).toBe(0);
    expect(await count(ctx.db)).toBe(2);
    expect((await addExclusion(ctx.db, s.ali.user.id, '905551112233')).purged).toBe(1);
    expect(await count(ctx.db)).toBe(1);
    expect(await listExclusions(ctx.db)).toHaveLength(1);
  });
});

describe('KVKK veri talebi', () => {
  async function seedMessages() {
    const s = await setup();
    const jid = '905551112233@s.whatsapp.net';
    await ingestMessage(ctx.db, s.tg.id, msg('group', 'tg', 't1', 'şirket grubunda, "tırnaklı", virgüllü', { senderExternalId: '905551112233', senderName: 'Zeynep' }));
    await ingestMessage(ctx.db, s.wa.id, msg('dm', jid, 'w1', 'Veli ile özel yazışma', { senderExternalId: jid, senderName: 'Zeynep' }));
    await ingestMessage(ctx.db, s.wa.id, msg('dm', jid, 'w2', 'Veli yanıtı', { fromMe: true }));
    await ingestMessage(ctx.db, s.wa.id, msg('group', 'g@g.us', 'w3', 'başkası', { senderExternalId: '905559998877@s.whatsapp.net' }));
    return s;
  }

  it('dışa aktarma: yönetici başkasının kişisel alanını okuyamaz, yalnız sayı görür', async () => {
    const s = await seedMessages();
    const out = await exportPersonData(ctx.db, s.ali.user.id, '+90 555 111 22 33', { asAdmin: true });
    expect(out.messages.map((m) => m.body)).toEqual(['şirket grubunda, "tırnaklı", virgüllü']);
    expect(out.hidden_by_access).toBe(2);
    const own = await exportPersonData(ctx.db, s.veli.user.id, '905551112233');
    expect(own.messages).toHaveLength(3);
    expect(own.hidden_by_access).toBe(0);
  });

  it('CSV: başlık, kaçışlı hücreler ve UTF-8 BOM', async () => {
    const s = await seedMessages();
    const csv = personExportCsv(await exportPersonData(ctx.db, s.ali.user.id, '905551112233', { asAdmin: true }));
    expect(csv.startsWith('﻿id,kaynak,')).toBe(true);
    expect(csv).toContain('"şirket grubunda, ""tırnaklı"", virgüllü"');
  });

  it('silme: kişisel alanlar dahil her yerden siler, birebir sohbeti kaldırır, başkalarına dokunmaz', async () => {
    const s = await seedMessages();
    const res = await erasePersonData(ctx.db, s.ali.user.id, '905551112233', { exclude: true, note: 'başvuru 12' });
    expect(res).toEqual({ messages: 3, conversations: 1, excluded: true });
    expect((await ctx.db.query('SELECT body FROM messages')).rows).toEqual([{ body: 'başkası' }]);
    expect(await isExcluded(ctx.db, ['905551112233'])).toBe(true);
  });

  it('denetim kaydı: ne yapıldığı yazılır, kimlik ve içerik yazılmaz', async () => {
    const s = await seedMessages();
    await exportPersonData(ctx.db, s.ali.user.id, '905551112233', { asAdmin: true, note: 'başvuru 11' });
    await erasePersonData(ctx.db, s.ali.user.id, '905551112233', { note: 'başvuru 12' });
    const log = await listAudit(ctx.db);
    expect(log.map((l) => l.action)).toEqual(['data.erase', 'data.export']);
    const raw = JSON.stringify(log);
    expect(raw).not.toContain('905551112233');
    expect(raw).not.toContain('tırnaklı');
    expect(log[0]).toMatchObject({ actor_name: 'Ali', target_type: 'person' });
    expect(log[0]!.detail).toMatchObject({ messages: 3, note: 'başvuru 12' });
  });
});
