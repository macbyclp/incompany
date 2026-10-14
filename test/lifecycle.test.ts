import { describe, expect, it } from 'vitest';
import { createAccount } from '../src/core/accounts.js';
import { grantConsent } from '../src/core/consent.js';
import { deleteIncomingMessage, ingestMessage } from '../src/core/ingest.js';
import { addExclusion } from '../src/core/privacy.js';
import { count, msg, SECRET, seedPeople, useDb } from './helpers.js';

const ctx = useDb();

async function bot(ownerId: number, space: number) {
  return createAccount(ctx.db, SECRET, { kind: 'telegram', ownerUserId: ownerId, label: 'bot', defaultSpaceId: space });
}
const body = async (externalId: string) =>
  (await ctx.db.query<{ body: string; edited_at: string | null }>('SELECT body, edited_at FROM messages WHERE external_id = $1', [externalId])).rows;

describe('düzenlenen mesaj', () => {
  it('içerik yerinde güncellenir, ikinci kayıt oluşmaz, önceki sürüm saklanmaz', async () => {
    const { ali, company } = await seedPeople(ctx.db);
    const acc = await bot(ali.user.id, company);
    await ingestMessage(ctx.db, acc.id, msg('group', 'g', '1', 'teklif 100 TL'));
    expect(await ingestMessage(ctx.db, acc.id, msg('group', 'g', '1', 'teklif 120 TL', { edit: true }))).toBe(true);
    const rows = await body('1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('teklif 120 TL');
    expect(rows[0]!.edited_at).not.toBeNull();
    expect(JSON.stringify((await ctx.db.query('SELECT * FROM messages')).rows)).not.toContain('100 TL');
  });

  it('edit işareti olmayan tekrar (geçmiş yeniden içe aktarma) mevcut içeriği ezmez', async () => {
    const { ali, company } = await seedPeople(ctx.db);
    const acc = await bot(ali.user.id, company);
    await ingestMessage(ctx.db, acc.id, msg('group', 'g', '1', 'ilk'));
    expect(await ingestMessage(ctx.db, acc.id, msg('group', 'g', '1', 'başka'))).toBe(false);
    expect((await body('1'))[0]!.body).toBe('ilk');
  });

  it('daha önce görülmemiş mesajın düzenlemesi kayıt olarak eklenir', async () => {
    const { ali, company } = await seedPeople(ctx.db);
    const acc = await bot(ali.user.id, company);
    expect(await ingestMessage(ctx.db, acc.id, msg('group', 'g', '9', 'sonradan düzeltilmiş', { edit: true }))).toBe(true);
    expect(await count(ctx.db)).toBe(1);
  });

  it('toplanmayan konuşmada ya da hariç tutulan kişiden gelen düzenleme kaydedilmez', async () => {
    const { ali, veli } = await seedPeople(ctx.db);
    const wa = await createAccount(ctx.db, SECRET, { kind: 'whatsapp', ownerUserId: veli.user.id, label: 'wa', defaultSpaceId: veli.personalSpaceId });
    await grantConsent(ctx.db, wa.id, veli.user.id, { dm: 'selected', group: 'all', history: false });
    expect(await ingestMessage(ctx.db, wa.id, msg('dm', 'a@s.whatsapp.net', '1', 'gizli', { edit: true }))).toBe(false);
    await addExclusion(ctx.db, ali.user.id, '+90 555 111 22 33');
    expect(await ingestMessage(ctx.db, wa.id, msg('group', 'g@g.us', '2', 'x', { edit: true, senderExternalId: '905551112233@s.whatsapp.net' }))).toBe(false);
    expect(await count(ctx.db)).toBe(0);
  });
});

describe('silinen mesaj', () => {
  it('kaynakta silinen mesaj burada da silinir; olmayan için false döner', async () => {
    const { ali, company } = await seedPeople(ctx.db);
    const acc = await bot(ali.user.id, company);
    await ingestMessage(ctx.db, acc.id, msg('group', 'g', '1', 'silinecek'));
    await ingestMessage(ctx.db, acc.id, msg('group', 'g', '2', 'kalacak'));
    expect(await deleteIncomingMessage(ctx.db, acc.id, 'g', '1')).toBe(true);
    expect(await deleteIncomingMessage(ctx.db, acc.id, 'g', '1')).toBe(false);
    expect((await ctx.db.query('SELECT external_id FROM messages')).rows).toEqual([{ external_id: '2' }]);
  });

  it('başka hesabın ya da başka konuşmanın aynı kimlikli mesajına dokunmaz', async () => {
    const { ali, company } = await seedPeople(ctx.db);
    const a = await bot(ali.user.id, company);
    const b = await bot(ali.user.id, company);
    await ingestMessage(ctx.db, a.id, msg('group', 'g', '1', 'a hesabı'));
    await ingestMessage(ctx.db, b.id, msg('group', 'g', '1', 'b hesabı'));
    await ingestMessage(ctx.db, a.id, msg('group', 'h', '1', 'a başka konuşma'));
    await deleteIncomingMessage(ctx.db, a.id, 'g', '1');
    expect((await ctx.db.query('SELECT body FROM messages ORDER BY body')).rows.map((r: any) => r.body))
      .toEqual(['a başka konuşma', 'b hesabı']);
  });
});
