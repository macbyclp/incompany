import { describe, expect, it } from 'vitest';
import { createAccount, getAccount } from '../src/core/accounts.js';
import { listAudit } from '../src/core/audit.js';
import { grantConsent } from '../src/core/consent.js';
import { ingestMessage } from '../src/core/ingest.js';
import { offboardUser } from '../src/core/offboarding.js';
import { search } from '../src/core/search.js';
import { addSpaceMember, createTeamSpace, listSpaceMembers, removeSpaceMember } from '../src/core/spaces.js';
import { createUser, listUsers, resetToken, revokeToken, userByToken } from '../src/core/users.js';
import { count, msg, SECRET, seedPeople, useDb } from './helpers.js';

const ctx = useDb();

describe('erişim anahtarı', () => {
  it('yenilenince eskisi hemen geçersiz, yenisi geçerli olur', async () => {
    const { ali, veli } = await seedPeople(ctx.db);
    const fresh = await resetToken(ctx.db, veli.user.id, ali.user.id);
    expect(await userByToken(ctx.db, veli.token)).toBeNull();
    expect((await userByToken(ctx.db, fresh))!.id).toBe(veli.user.id);
    expect((await listAudit(ctx.db))[0]).toMatchObject({ action: 'token.reset', target_id: String(veli.user.id) });
    await resetToken(ctx.db, ali.user.id, ali.user.id);
    expect((await listAudit(ctx.db))[0]!.action).toBe('token.rotate');
  });

  it('iptal edilince kullanıcı yeni anahtar verilene kadar giremez', async () => {
    const { ali, veli } = await seedPeople(ctx.db);
    await revokeToken(ctx.db, veli.user.id, ali.user.id);
    expect(await userByToken(ctx.db, veli.token)).toBeNull();
    expect((await listUsers(ctx.db)).find((u) => u.id === veli.user.id)!.has_token).toBe(false);
    await expect(revokeToken(ctx.db, 9999, ali.user.id)).rejects.toThrow();
  });
});

async function veliWithData() {
  const p = await seedPeople(ctx.db);
  const wa = await createAccount(ctx.db, SECRET, { kind: 'whatsapp', ownerUserId: p.veli.user.id, label: 'wa', defaultSpaceId: p.veli.personalSpaceId, secrets: { x: '1' } as any });
  await grantConsent(ctx.db, wa.id, p.veli.user.id, { dm: 'all', group: 'all', history: false });
  const bot = await createAccount(ctx.db, SECRET, { kind: 'telegram', ownerUserId: p.veli.user.id, label: 'bot', defaultSpaceId: p.company, secrets: { botToken: 't' } });
  await ingestMessage(ctx.db, wa.id, msg('dm', 'z@s.whatsapp.net', '1', 'özel yazışma gizli'));
  await ingestMessage(ctx.db, bot.id, msg('group', 'g', '2', 'ortak grup mesajı'));
  return { ...p, wa, bot };
}

describe('ayrılan çalışan', () => {
  it('kişisel alan silinir: mesajlar gider, hesap durur ve sırları silinir, ortak kayıtlar kalır', async () => {
    const s = await veliWithData();
    const res = await offboardUser(ctx.db, s.ali.user.id, s.veli.user.id, { personal: 'delete' });
    expect(res).toMatchObject({ stopped: [{ id: s.wa.id, kind: 'whatsapp' }], reassignedBots: [s.bot.id], deletedMessages: 1, archiveSpaceId: null });

    expect(await userByToken(ctx.db, s.veli.token)).toBeNull();
    const wa = (await getAccount(ctx.db, s.wa.id))!;
    expect(wa).toMatchObject({ enabled: false, status: 'disabled', consent_at: null });
    expect((await ctx.db.query('SELECT secrets FROM accounts WHERE id = $1', [s.wa.id])).rows[0]).toEqual({ secrets: null });
    expect((await ctx.db.query('SELECT body FROM messages')).rows).toEqual([{ body: 'ortak grup mesajı' }]);
    expect((await ctx.db.query('SELECT 1 FROM space_members WHERE user_id = $1', [s.veli.user.id])).rows).toHaveLength(0);
    expect((await ctx.db.query(`SELECT action, purged FROM consent_log WHERE action = 'revoke'`)).rows).toEqual([{ action: 'revoke', purged: true }]);
    expect((await listAudit(ctx.db))[0]).toMatchObject({ action: 'user.offboard' });
  });

  it('şirket botu işlemi yapan yöneticiye geçer ve çalışmaya devam eder', async () => {
    const s = await veliWithData();
    await offboardUser(ctx.db, s.ali.user.id, s.veli.user.id, { personal: 'delete' });
    const bot = (await getAccount(ctx.db, s.bot.id))!;
    expect(bot).toMatchObject({ owner_user_id: s.ali.user.id, enabled: true });
    expect(await ingestMessage(ctx.db, s.bot.id, msg('group', 'g', '3', 'ayrıldıktan sonra da'))).toBe(true);
  });

  it('devir: kişisel alan seçilen kişiye ekip alanı olarak geçer, başkası göremez', async () => {
    const s = await veliWithData();
    const res = await offboardUser(ctx.db, s.ali.user.id, s.veli.user.id, { personal: 'transfer', transferTo: s.ayse.user.id });
    expect(res.archiveSpaceId).not.toBeNull();
    expect(res.deletedMessages).toBe(0);
    expect(await count(ctx.db)).toBe(2);
    expect((await search(ctx.db, s.ayse.user.id, 'gizli')).map((h) => h.space_name)).toEqual(['Veli (devredilen)']);
    expect(await search(ctx.db, s.ali.user.id, 'gizli')).toHaveLength(0);
  });

  it('korumalar: kendini, son yöneticiyi, iki kez ve geçersiz devri engeller', async () => {
    const s = await veliWithData();
    await expect(offboardUser(ctx.db, s.ali.user.id, s.ali.user.id, { personal: 'delete' })).rejects.toThrow(/Kendi/);
    const other = await createUser(ctx.db, { name: 'Yönetici 2', isAdmin: true });
    await expect(offboardUser(ctx.db, other.user.id, s.ali.user.id, { personal: 'delete' })).resolves.toBeDefined();
    await expect(offboardUser(ctx.db, s.ayse.user.id, other.user.id, { personal: 'delete' })).rejects.toThrow(/Son yönetici/);
    await expect(offboardUser(ctx.db, other.user.id, s.veli.user.id, { personal: 'delete' })).resolves.toBeDefined();
    await expect(offboardUser(ctx.db, other.user.id, s.veli.user.id, { personal: 'delete' })).rejects.toThrow(/zaten/);
    await expect(offboardUser(ctx.db, other.user.id, s.ayse.user.id, { personal: 'transfer' })).rejects.toThrow(/Devir/);
    await expect(offboardUser(ctx.db, other.user.id, s.ayse.user.id, { personal: 'transfer', transferTo: s.veli.user.id })).rejects.toThrow(/Devir/);
  });
});

describe('ekip alanları', () => {
  it('kurulur, üye eklenir/çıkarılır; üye alandaki mesajı arayabilir', async () => {
    const { ali, veli, ayse } = await seedPeople(ctx.db);
    const team = await createTeamSpace(ctx.db, ali.user.id, ' Satış ');
    expect(team.name).toBe('Satış');
    expect(await listSpaceMembers(ctx.db, team.id)).toMatchObject([{ user_id: ali.user.id, role: 'admin' }]);

    await addSpaceMember(ctx.db, ali.user.id, team.id, veli.user.id);
    const bot = await createAccount(ctx.db, SECRET, { kind: 'telegram', ownerUserId: ali.user.id, label: 'b', defaultSpaceId: team.id });
    await ingestMessage(ctx.db, bot.id, msg('group', 'g', '1', 'fiyat listesi güncellendi'));
    expect(await search(ctx.db, veli.user.id, 'fiyat')).toHaveLength(1);
    expect(await search(ctx.db, ayse.user.id, 'fiyat')).toHaveLength(0);

    await removeSpaceMember(ctx.db, ali.user.id, team.id, veli.user.id);
    expect(await search(ctx.db, veli.user.id, 'fiyat')).toHaveLength(0);
    await expect(removeSpaceMember(ctx.db, ali.user.id, team.id, veli.user.id)).rejects.toThrow(/bulunamadı/);
    expect((await listAudit(ctx.db)).map((l) => l.action)).toEqual(['space.member_remove', 'space.member_add', 'space.create']);
  });

  it('yalnız ekip alanları yönetilir; devre dışı kullanıcı eklenemez; boş ad reddedilir', async () => {
    const { ali, veli, ayse, company } = await seedPeople(ctx.db);
    const team = await createTeamSpace(ctx.db, ali.user.id, 'Destek');
    await expect(addSpaceMember(ctx.db, ali.user.id, company, veli.user.id)).rejects.toThrow(/Ekip alanı/);
    await expect(addSpaceMember(ctx.db, ali.user.id, veli.personalSpaceId, ayse.user.id)).rejects.toThrow(/Ekip alanı/);
    await offboardUser(ctx.db, ali.user.id, ayse.user.id, { personal: 'delete' });
    await expect(addSpaceMember(ctx.db, ali.user.id, team.id, ayse.user.id)).rejects.toThrow(/devre dışı/);
    await expect(createTeamSpace(ctx.db, ali.user.id, '  ')).rejects.toThrow();
  });
});
