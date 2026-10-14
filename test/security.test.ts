import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FailureLock, RateLimiter } from '../src/api/ratelimit.js';
import { loadKeyring } from '../src/config.js';
import { createAccount, decryptSecrets, encryptSecrets, needsRotation, rotateSecrets, accountSecrets } from '../src/core/accounts.js';
import { ingestMessage } from '../src/core/ingest.js';
import { createTeamSpace, addSpaceMember } from '../src/core/spaces.js';
import { msg, SECRET, seedPeople, useDb } from './helpers.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);

describe('anahtar türetme ve rotasyon', () => {
  it('yeni kayıtlar v2 biçiminde, scrypt ile türetilmiş anahtarla şifrelenir', () => {
    const blob = encryptSecrets(A, { botToken: 'xoxb-1' });
    expect(blob.split('.')).toHaveLength(5);
    expect(blob.startsWith('v2.')).toBe(true);
    expect(decryptSecrets(A, blob)).toEqual({ botToken: 'xoxb-1' });
    expect(encryptSecrets(A, { a: '1' })).not.toBe(encryptSecrets(A, { a: '1' })); // her seferinde yeni iv
    expect(() => decryptSecrets(B, blob)).toThrow(/anahtar yok/);
  });

  it('eski (v1, tek SHA-256) kayıtlar okunur ve rotasyonla v2ye yükseltilir', () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(A).digest(), iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify({ password: 'p' }), 'utf8'), cipher.final()]);
    const legacy = [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
    expect(decryptSecrets(A, legacy)).toEqual({ password: 'p' });
    expect(needsRotation(A, legacy)).toBe(true);
    expect(needsRotation(A, encryptSecrets(A, {}))).toBe(false);
    expect(() => decryptSecrets(B, legacy)).toThrow();
  });

  it('anahtar halkası: eski anahtarla şifreli kayıt okunur, yeni anahtar gelince şifrelenen eskisi okuyabilir', () => {
    const old = encryptSecrets(A, { k: 'v' });
    expect(decryptSecrets({ current: B, previous: [A] }, old)).toEqual({ k: 'v' });
    expect(() => decryptSecrets({ current: B, previous: [C] }, old)).toThrow(/APP_SECRET_PREVIOUS/);
    expect(needsRotation({ current: B, previous: [A] }, old)).toBe(true);
    expect(needsRotation({ current: A }, old)).toBe(false);
  });

  it('loadKeyring doğrular', () => {
    expect(loadKeyring({ APP_SECRET: A, APP_SECRET_PREVIOUS: `${B}, ${C}` })).toEqual({ current: A, previous: [B, C] });
    expect(loadKeyring({ APP_SECRET: A }).previous).toEqual([]);
    expect(() => loadKeyring({})).toThrow(/gerekli/);
    expect(() => loadKeyring({ APP_SECRET: 'kısa' })).toThrow(/24/);
    expect(() => loadKeyring({ APP_SECRET: A, APP_SECRET_PREVIOUS: 'kısa' })).toThrow(/24/);
    expect(() => loadKeyring({ APP_SECRET: A, APP_SECRET_PREVIOUS: A })).toThrow(/içeremez/);
  });
});

const ctx = useDb();

describe('rotateSecrets (veritabanında)', () => {
  it('tüm hesap sırlarını yeni anahtarla yeniden şifreler; eski anahtar atıldıktan sonra da okunur', async () => {
    const { ali, company } = await seedPeople(ctx.db);
    const mk = (label: string) => createAccount(ctx.db, A, { kind: 'telegram', ownerUserId: ali.user.id, label, defaultSpaceId: company, secrets: { botToken: label } });
    const one = await mk('bir'), two = await mk('iki');
    await createAccount(ctx.db, A, { kind: 'whatsapp', ownerUserId: ali.user.id, label: 'sırsız', defaultSpaceId: company });

    const ring = { current: B, previous: [A] };
    expect(await accountSecrets(ctx.db, ring, one.id)).toEqual({ botToken: 'bir' }); // eski anahtarla hâlâ okunur
    expect(await rotateSecrets(ctx.db, ring)).toEqual({ total: 2, rotated: 2 });
    expect(await rotateSecrets(ctx.db, ring)).toEqual({ total: 2, rotated: 0 });

    // eski anahtar artık gerekmez
    expect(await accountSecrets(ctx.db, B, one.id)).toEqual({ botToken: 'bir' });
    expect(await accountSecrets(ctx.db, B, two.id)).toEqual({ botToken: 'iki' });
    await expect(accountSecrets(ctx.db, A, one.id)).rejects.toThrow();
  });

  it('okunamayan kayıt varsa işlem yarıda kalmaz, hiçbir kayıt değişmez', async () => {
    const { ali, company } = await seedPeople(ctx.db);
    const ok = await createAccount(ctx.db, A, { kind: 'telegram', ownerUserId: ali.user.id, label: 'ok', defaultSpaceId: company, secrets: { t: '1' } });
    await createAccount(ctx.db, C, { kind: 'telegram', ownerUserId: ali.user.id, label: 'başka anahtar', defaultSpaceId: company, secrets: { t: '2' } });
    const before = (await ctx.db.query('SELECT secrets FROM accounts WHERE id = $1', [ok.id])).rows[0];
    await expect(rotateSecrets(ctx.db, { current: B, previous: [A] })).rejects.toThrow();
    expect((await ctx.db.query('SELECT secrets FROM accounts WHERE id = $1', [ok.id])).rows[0]).toEqual(before);
  });
});

describe('hız sınırlayıcılar', () => {
  it('RateLimiter: pencere dolunca bekleme süresini söyler, pencere kayınca açılır', () => {
    let now = 0;
    const rl = new RateLimiter(3, 60_000, () => now);
    expect([rl.consume('a'), rl.consume('a'), rl.consume('a')]).toEqual([null, null, null]);
    now = 10_000;
    expect(rl.consume('a')).toBe(50);
    expect(rl.consume('b')).toBeNull(); // anahtarlar bağımsız
    now = 60_001;
    expect(rl.consume('a')).toBeNull();
  });

  it('FailureLock: eşik aşılınca kilitler, süre dolunca açar; başarısız denemeler pencerede sayılır', () => {
    let now = 0;
    const lock = new FailureLock(3, 60_000, 900_000, () => now);
    lock.fail('ip'); lock.fail('ip');
    expect(lock.remaining('ip')).toBe(0);
    now = 70_000; // pencere kaydı: ilk iki deneme düştü
    lock.fail('ip');
    expect(lock.remaining('ip')).toBe(0);
    lock.fail('ip'); lock.fail('ip');
    expect(lock.remaining('ip')).toBe(900);
    expect(lock.remaining('başka')).toBe(0);
    now = 70_000 + 900_001;
    expect(lock.remaining('ip')).toBe(0);
    lock.fail('ip');
    expect(lock.remaining('ip')).toBe(0); // kilit açılınca sayaç sıfırlanır
  });
});

describe('satır düzeyi güvenlik (RLS)', () => {
  async function world() {
    const p = await seedPeople(ctx.db);
    const wa = await createAccount(ctx.db, SECRET, { kind: 'telegram', ownerUserId: p.veli.user.id, label: 'veli', defaultSpaceId: p.veli.personalSpaceId, secrets: { botToken: 'GİZLİ' } });
    await ctx.db.query(`UPDATE accounts SET consent_at = now() WHERE id = $1`, [wa.id]);
    await ingestMessage(ctx.db, wa.id, msg('dm', 'd', '1', 'veli kişisel'));
    const bot = await createAccount(ctx.db, SECRET, { kind: 'telegram', ownerUserId: p.ali.user.id, label: 'şirket', defaultSpaceId: p.company });
    await ingestMessage(ctx.db, bot.id, msg('group', 'g', '2', 'şirket ortak'));
    return { ...p, wa, bot };
  }
  const visible = (uid: number, table = 'messages') =>
    ctx.db.asUser(uid, async (tx) => (await tx.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n).then(Number);

  it('veritabanı, sorgu ne olursa olsun yalnız kullanıcının erişebildiği satırları verir', async () => {
    const s = await world();
    // filtresiz SELECT *: yönetici bile Veli'nin kişisel mesajını ve konuşmasını göremez
    expect(await visible(s.veli.user.id)).toBe(2);
    expect(await visible(s.ali.user.id)).toBe(1);
    expect(await visible(s.ayse.user.id)).toBe(1);
    expect(await visible(s.veli.user.id, 'conversations')).toBe(2);
    expect(await visible(s.ali.user.id, 'conversations')).toBe(1);
    expect(await visible(s.ayse.user.id, 'spaces')).toBe(2); // kendi kişisel alanı + şirket
    // sahibi olmayan kullanıcının kimliğiyle de olmayan kimlik hiçbir şey görmez
    expect(await visible(999_999)).toBe(0);
  });

  it('ekip alanına üye olunca satırlar görünür, çıkarılınca kaybolur', async () => {
    const s = await world();
    const team = await createTeamSpace(ctx.db, s.ali.user.id, 'Ekip');
    const bot = await createAccount(ctx.db, SECRET, { kind: 'telegram', ownerUserId: s.ali.user.id, label: 'ekip botu', defaultSpaceId: team.id });
    await ingestMessage(ctx.db, bot.id, msg('group', 'e', '3', 'ekip mesajı'));
    expect(await visible(s.ayse.user.id)).toBe(1);
    await addSpaceMember(ctx.db, s.ali.user.id, team.id, s.ayse.user.id);
    expect(await visible(s.ayse.user.id)).toBe(2);
  });

  it('gizli sütunlar (secrets, token_hash) ve yazma okuma rolüne kapalıdır', async () => {
    const s = await world();
    await expect(ctx.db.asUser(s.ali.user.id, (tx) => tx.query('SELECT secrets FROM accounts'))).rejects.toThrow(/permission denied/);
    await expect(ctx.db.asUser(s.ali.user.id, (tx) => tx.query('SELECT token_hash FROM users'))).rejects.toThrow(/permission denied/);
    await expect(ctx.db.asUser(s.ali.user.id, (tx) => tx.query('DELETE FROM messages'))).rejects.toThrow();
    await expect(ctx.db.asUser(s.ali.user.id, (tx) => tx.query(`UPDATE users SET is_admin = true`))).rejects.toThrow();
    // gizli olmayan sütunlar okunabilir
    await expect(ctx.db.asUser(s.ali.user.id, (tx) => tx.query('SELECT id, label, status FROM accounts'))).resolves.toBeDefined();
    expect((await ctx.db.query('SELECT count(*) AS n FROM messages')).rows[0]).toEqual({ n: 2 });
  });

  it('asUser içinde iç içe asUser kimliği değiştirmez', async () => {
    const s = await world();
    // Ali'nin işleminde Veli kimliği istense de işlem Ali'nin kimliğiyle sürer: Veli'nin kişisel mesajı görünmez.
    expect(await ctx.db.asUser(s.ali.user.id, (tx) => tx.asUser(s.veli.user.id,
      async (inner) => Number((await inner.query('SELECT count(*) AS n FROM messages')).rows[0]!.n)))).toBe(1);
  });

  // Bilinen sınır (docs/guvenlik.md): uygulama veritabanına süper kullanıcı olarak bağlanıyorsa, enjekte edilmiş
  // bir SQL "SET ROLE" ile okuma rolünden çıkabilir. RLS sorgu hatalarına karşı korur, SQL enjeksiyonuna karşı değil
  // (tüm sorgular parametreli). Bu yüzden burada yetki yükseltmenin engellendiği iddia edilmez.
});
