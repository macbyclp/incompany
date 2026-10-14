import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type ServerOptions } from '../src/api/server.js';
import { createAccount, setAccountStatus } from '../src/core/accounts.js';
import { grantConsent } from '../src/core/consent.js';
import { ingestMessage } from '../src/core/ingest.js';
import { msg, SECRET, seedPeople, useDb } from './helpers.js';

const ctx = useDb();
let calls: string[] = [];
const apps: Array<ReturnType<typeof buildServer>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

function server(limits?: ServerOptions['limits']) {
  calls = [];
  const app = buildServer({ db: ctx.db, appSecret: SECRET, limits, connectors: {
    start: async (id) => { calls.push(`start:${id}`); },
    stop: async (id) => { calls.push(`stop:${id}`); },
    pairingQr: () => null,
    sessionDir: (k, id) => join(tmpdir(), 'incompany-test', k, String(id)),
  } });
  apps.push(app);
  return app;
}

type App = ReturnType<typeof server>;
const call = async (app: App, token: string | null, method: string, url: string, payload?: unknown, remoteAddress = '10.0.0.1') => {
  const res = await app.inject({ method: method as any, url, payload: payload as any, remoteAddress,
    headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json: any; try { json = res.json(); } catch { json = undefined; }
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
};

/** Veli'nin kişisel WhatsApp'ı + şirket Telegram botu (Ali) ve her birinde birkaç mesaj. */
async function world() {
  const p = await seedPeople(ctx.db);
  const wa = await createAccount(ctx.db, SECRET, { kind: 'whatsapp', ownerUserId: p.veli.user.id, label: 'Veli WA', defaultSpaceId: p.veli.personalSpaceId });
  await grantConsent(ctx.db, wa.id, p.veli.user.id, { dm: 'all', group: 'all', history: false });
  const tg = await createAccount(ctx.db, SECRET, { kind: 'telegram', ownerUserId: p.ali.user.id, label: 'Şirket bot', defaultSpaceId: p.company, secrets: { botToken: 't' } });
  await ingestMessage(ctx.db, wa.id, msg('dm', 'zeynep@s.whatsapp.net', 'w1', 'tedarikçi fiyat listesi çok gizli'));
  for (let i = 1; i <= 5; i++) {
    await ingestMessage(ctx.db, tg.id, msg('group', `g${i}`, `t${i}`, `ortak lansman notu ${i}`, { sentAt: new Date(Date.now() - (6 - i) * 60_000), senderName: i % 2 ? 'Ayşe' : 'Mehmet' }));
  }
  return { ...p, wa, tg };
}

describe('yönetici kişisel alanı göremez (API)', () => {
  it('konuşma listesi, mesajlar, kişiler ve arama Veli\'nin kişisel verisini yöneticiye vermez', async () => {
    const s = await world(); const app = server();
    const convs = (await call(app, s.veli.token, 'GET', '/conversations')).json.items;
    const personal = convs.find((c: any) => c.source === 'whatsapp');
    expect(personal).toBeTruthy();

    const adminList = (await call(app, s.ali.token, 'GET', '/conversations')).json.items;
    expect(adminList.some((c: any) => c.source === 'whatsapp')).toBe(false);
    expect((await call(app, s.ali.token, 'GET', `/conversations/${personal.id}/messages`)).status).toBe(404);
    expect((await call(app, s.ali.token, 'GET', `/conversations/${personal.id}/people`)).status).toBe(404);
    expect((await call(app, s.ali.token, 'GET', '/search?q=gizli')).json).toHaveLength(0);
    expect((await call(app, s.veli.token, 'GET', '/search?q=gizli')).json).toHaveLength(1);
    expect((await call(app, s.veli.token, 'GET', `/conversations/${personal.id}/messages`)).json.items).toHaveLength(1);
  });

  it('yönetici Veli\'nin hesaplarına dokunamaz: rıza, yeniden başlatma, kaldırma', async () => {
    const s = await world(); const app = server();
    expect((await call(app, s.ali.token, 'POST', `/accounts/${s.wa.id}/restart`)).status).toBe(404);
    expect((await call(app, s.ali.token, 'DELETE', `/accounts/${s.wa.id}`)).status).toBe(404);
    expect((await call(app, s.ali.token, 'DELETE', `/accounts/${s.wa.id}/consent`, { purge: true })).status).toBe(404);
    expect((await call(app, s.ali.token, 'GET', '/accounts')).json.map((a: any) => a.label)).toEqual(['Şirket bot']);
  });
});

describe('sayfalama', () => {
  it('konuşma listesi imleçle sayfalanır; arama ve kaynak süzgeci çalışır', async () => {
    const s = await world(); const app = server();
    const first = (await call(app, s.ayse.token, 'GET', '/conversations?limit=2')).json;
    expect(first.items).toHaveLength(2);
    expect(first.next).toBe(first.items[1].id);
    const second = (await call(app, s.ayse.token, 'GET', `/conversations?limit=2&before=${first.next}`)).json;
    const third = (await call(app, s.ayse.token, 'GET', `/conversations?limit=2&before=${second.next}`)).json;
    expect([...first.items, ...second.items, ...third.items].map((c: any) => c.title).sort()).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
    expect(third.next).toBeNull();
    expect((await call(app, s.ayse.token, 'GET', '/conversations?q=g3')).json.items.map((c: any) => c.title)).toEqual(['g3']);
    expect((await call(app, s.ayse.token, 'GET', '/conversations?q=%25')).json.items).toHaveLength(0); // % joker sayılmaz
    expect((await call(app, s.veli.token, 'GET', '/conversations?source=whatsapp')).json.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ messages: 1, source: 'telegram' });
  });

  it('mesajlar eskiye doğru sayfalanır, sıra eskiden yeniye döner', async () => {
    const s = await world(); const app = server();
    const conv = (await call(app, s.ayse.token, 'GET', '/conversations?q=g1')).json.items[0];
    for (let i = 2; i <= 7; i++) {
      await ingestMessage(ctx.db, s.tg.id, msg('group', 'g1', `x${i}`, `ek ${i}`, { sentAt: new Date(Date.now() + i * 1000) }));
    }
    const page1 = (await call(app, s.ayse.token, 'GET', `/conversations/${conv.id}/messages?limit=3`)).json;
    expect(page1.items.map((m: any) => m.body)).toEqual(['ek 5', 'ek 6', 'ek 7']);
    expect(page1.hasMore).toBe(true);
    const oldest = page1.items[0];
    const page2 = (await call(app, s.ayse.token, 'GET', `/conversations/${conv.id}/messages?limit=10&beforeAt=${encodeURIComponent(new Date(oldest.sent_at).toISOString())}&beforeId=${oldest.id}`)).json;
    expect(page2.items.map((m: any) => m.body)).toEqual(['ortak lansman notu 1', 'ek 2', 'ek 3', 'ek 4']);
    expect(page2.hasMore).toBe(false);
  });

  it('arama sayfalanır', async () => {
    const s = await world(); const app = server();
    const a = (await call(app, s.ayse.token, 'GET', '/search?q=lansman&limit=3')).json;
    const b = (await call(app, s.ayse.token, 'GET', '/search?q=lansman&limit=3&offset=3')).json;
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(2);
    expect(new Set([...a, ...b].map((h: any) => h.id)).size).toBe(5);
  });

  it('kişi bazlı bakış: kim ne kadar yazmış, son aktivite', async () => {
    const s = await world(); const app = server();
    for (let i = 0; i < 3; i++) await ingestMessage(ctx.db, s.tg.id, msg('group', 'g1', `p${i}`, `x${i}`, { senderName: 'Ayşe' }));
    const conv = (await call(app, s.ayse.token, 'GET', '/conversations?q=g1')).json.items[0];
    const people = (await call(app, s.ayse.token, 'GET', `/conversations/${conv.id}/people`)).json;
    expect(people[0]).toMatchObject({ name: 'Ayşe', messages: 4 });
    expect(people[0].last_at).toBeTruthy();
  });
});

describe('sağlık', () => {
  it('/health herkese açık ve yalnız sayı verir; sorunlu bağlayıcı sayılır, etiket sızmaz', async () => {
    const s = await world(); const app = server();
    await setAccountStatus(ctx.db, s.tg.id, 'connected');
    expect((await call(app, null, 'GET', '/health')).json).toMatchObject({ ok: true, db: true, connectors: { ok: true, problems: 0, connected: 1 } });
    await setAccountStatus(ctx.db, s.tg.id, 'error', 'getUpdates 401');
    const res = await call(app, null, 'GET', '/health');
    expect(res.json.connectors).toMatchObject({ ok: false, problems: 1 });
    expect(res.body).not.toContain('getUpdates');
    expect(res.body).not.toContain('Şirket bot');
  });

  it('/health/connectors yalnız yöneticiye; sorunlu hesabın ayrıntısı ve son eşitleme anı döner', async () => {
    const s = await world(); const app = server();
    await setAccountStatus(ctx.db, s.tg.id, 'connected');
    await setAccountStatus(ctx.db, s.tg.id, 'error', 'getUpdates 401');
    expect((await call(app, s.veli.token, 'GET', '/health/connectors')).status).toBe(403);
    const admin = (await call(app, s.ali.token, 'GET', '/health/connectors')).json;
    expect(admin.problems[0]).toMatchObject({ label: 'Şirket bot', status: 'error', status_detail: 'getUpdates 401' });
    expect(admin.problems[0].last_sync_at).toBeTruthy(); // 'connected' anı korunur
  });

  it('genel bakış: yönetici şirket botunun sorununu, üye yalnız kendininkini görür', async () => {
    const s = await world(); const app = server();
    await setAccountStatus(ctx.db, s.tg.id, 'logged_out', 'oturum kapandı');
    await setAccountStatus(ctx.db, s.wa.id, 'reconnecting');
    expect((await call(app, s.ali.token, 'GET', '/overview')).json.problems.map((p: any) => p.label)).toEqual(['Şirket bot']);
    expect((await call(app, s.veli.token, 'GET', '/overview')).json.problems.map((p: any) => p.label)).toEqual(['Veli WA']);
    expect((await call(app, s.ayse.token, 'GET', '/overview')).json.problems).toEqual([]);
  });

  it('yeniden başlatma: sahibi ve (şirket botu için) yönetici yapabilir', async () => {
    const s = await world(); const app = server();
    expect((await call(app, s.ali.token, 'POST', `/accounts/${s.tg.id}/restart`)).status).toBe(200);
    expect((await call(app, s.veli.token, 'POST', `/accounts/${s.wa.id}/restart`)).status).toBe(200);
    expect((await call(app, s.ayse.token, 'POST', `/accounts/${s.tg.id}/restart`)).status).toBe(404);
    expect(calls).toEqual([`start:${s.tg.id}`, `start:${s.wa.id}`]);
  });
});

describe('kimlik doğrulama ve hız sınırları', () => {
  it('çok sayıda başarısız denemeden sonra IP kilitlenir; geçerli anahtar da o IP\'den reddedilir', async () => {
    const s = await world(); const app = server({ failuresBeforeLock: 3 });
    for (let i = 0; i < 3; i++) expect((await call(app, 'yanlis', 'GET', '/me', undefined, '10.9.9.9')).status).toBe(401);
    const locked = await call(app, s.ali.token, 'GET', '/me', undefined, '10.9.9.9');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    // başka IP etkilenmez, /health ve panel sayfası açık kalır
    expect((await call(app, s.ali.token, 'GET', '/me', undefined, '10.1.1.1')).status).toBe(200);
    expect((await call(app, null, 'GET', '/health', undefined, '10.9.9.9')).status).toBe(200);
    expect((await call(app, null, 'GET', '/', undefined, '10.9.9.9')).status).toBe(200);
  });

  it('anahtarsız istekler (favicon, yoklama) kilide sayılmaz; yalnız reddedilen anahtar denemeleri sayılır', async () => {
    const s = await world(); const app = server({ failuresBeforeLock: 3 });
    for (let i = 0; i < 10; i++) expect((await call(app, null, 'GET', '/favicon.ico', undefined, '10.3.3.3')).status).toBe(401);
    expect((await call(app, s.ali.token, 'GET', '/me', undefined, '10.3.3.3')).status).toBe(200);
  });

  it('başarılı girişler kilide sayılmaz', async () => {
    const s = await world(); const app = server({ failuresBeforeLock: 3 });
    for (let i = 0; i < 6; i++) expect((await call(app, s.ali.token, 'GET', '/me', undefined, '10.2.2.2')).status).toBe(200);
  });

  it('arama dakikada sınırlıdır ve kullanıcı başınadır', async () => {
    const s = await world(); const app = server({ searchPerMinute: 2 });
    expect((await call(app, s.ali.token, 'GET', '/search?q=lansman')).status).toBe(200);
    expect((await call(app, s.ali.token, 'GET', '/search?q=lansman')).status).toBe(200);
    const limited = await call(app, s.ali.token, 'GET', '/search?q=lansman');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
    expect((await call(app, s.veli.token, 'GET', '/search?q=lansman')).status).toBe(200);
  });

  it('erişim anahtarı yenilenince eskisi 401 verir; devre dışı kullanıcı giremez', async () => {
    const s = await world(); const app = server();
    const { token } = (await call(app, s.veli.token, 'POST', '/me/token/rotate')).json;
    expect((await call(app, s.veli.token, 'GET', '/me')).status).toBe(401);
    expect((await call(app, token, 'GET', '/me')).json.name).toBe('Veli');
    expect((await call(app, s.ali.token, 'POST', `/users/${s.veli.user.id}/token/revoke`)).status).toBe(200);
    expect((await call(app, token, 'GET', '/me')).status).toBe(401);
    const fresh = (await call(app, s.ali.token, 'POST', `/users/${s.veli.user.id}/token/reset`)).json.token;
    expect((await call(app, fresh, 'GET', '/me')).status).toBe(200);
    expect((await call(app, fresh, 'POST', `/users/${s.ayse.user.id}/token/reset`)).status).toBe(403);
  });
});

describe('rıza ve aydınlatma metni (API)', () => {
  it('metin herkese okunur; yalnız yönetici günceller; güncelleme ilgili bağlayıcıları durdurur', async () => {
    const s = await world(); const app = server();
    expect((await call(app, s.veli.token, 'GET', '/consent-text')).json).toMatchObject({ version: 1 });
    expect((await call(app, s.veli.token, 'PUT', '/consent-text', { text: 'x'.repeat(40) })).status).toBe(403);
    const res = await call(app, s.ali.token, 'PUT', '/consent-text', { text: 'Güncellenmiş aydınlatma metni, ayrıntılı ve açık.' });
    expect(res.json).toEqual({ version: 2, stale: [s.wa.id] });
    expect(calls).toContain(`stop:${s.wa.id}`);
    expect((await call(app, s.veli.token, 'GET', '/accounts')).json[0].status).toBe('awaiting_consent');
  });

  it('eski sürümü okuyan istemci 409 alır; güncel sürümle onay ve saklama süresi kaydedilir', async () => {
    const s = await world(); const app = server();
    await call(app, s.ali.token, 'PUT', '/consent-text', { text: 'Güncellenmiş aydınlatma metni, ayrıntılı ve açık.' });
    const scope = { dm: 'selected', group: 'all', history: false, retention_days: 90 };
    expect((await call(app, s.veli.token, 'POST', `/accounts/${s.wa.id}/consent`, { ...scope, textVersion: 1 })).status).toBe(409);
    expect((await call(app, s.veli.token, 'POST', `/accounts/${s.wa.id}/consent`, { ...scope, textVersion: 2 })).status).toBe(200);
    const acc = (await call(app, s.veli.token, 'GET', '/accounts')).json[0];
    expect(acc).toMatchObject({ consent_text_version: 2, consent_scope: { retention_days: 90 } });
    expect((await call(app, s.veli.token, 'GET', '/consent-log')).json[0]).toMatchObject({ action: 'scope_change', text_version: 2 });
    expect((await call(app, s.veli.token, 'POST', `/accounts/${s.wa.id}/consent`, { ...scope, retention_days: 0 })).status).toBe(400);
  });

  it('şirket saklama süresi ayarı yöneticiye özeldir', async () => {
    const s = await world(); const app = server();
    expect((await call(app, s.veli.token, 'PUT', '/settings/retention', { days: 30 })).status).toBe(403);
    expect((await call(app, s.ali.token, 'PUT', '/settings/retention', { days: 30 })).status).toBe(200);
    expect((await call(app, s.ali.token, 'GET', '/settings/retention')).json).toEqual({ company_days: 30 });
    expect((await call(app, s.ali.token, 'PUT', '/settings/retention', { days: 0 })).status).toBe(400);
  });
});

describe('ekip alanları ve kullanıcı yönetimi (API)', () => {
  it('yönetici alan kurar ve üye ekler; alan yöneticisi kendi alanını yönetir, sıradan üye yönetemez', async () => {
    const s = await world(); const app = server();
    expect((await call(app, s.veli.token, 'POST', '/spaces', { name: 'Satış' })).status).toBe(403);
    const space = (await call(app, s.ali.token, 'POST', '/spaces', { name: 'Satış' })).json;
    expect((await call(app, s.veli.token, 'GET', '/spaces/team')).status).toBe(403);
    expect((await call(app, s.ali.token, 'GET', '/spaces/team')).json).toEqual([{ id: space.id, name: 'Satış', members: 1 }]);
    expect((await call(app, s.ali.token, 'POST', `/spaces/${space.id}/members`, { userId: s.veli.user.id, role: 'admin' })).status).toBe(200);
    expect((await call(app, s.veli.token, 'POST', `/spaces/${space.id}/members`, { userId: s.ayse.user.id })).status).toBe(200);
    expect((await call(app, s.ayse.token, 'POST', `/spaces/${space.id}/members`, { userId: s.ali.user.id })).status).toBe(403);
    expect((await call(app, s.ayse.token, 'GET', `/spaces/${space.id}/members`)).json.map((m: any) => m.name).sort()).toEqual(['Ali', 'Ayşe', 'Veli']);
    expect((await call(app, s.veli.token, 'DELETE', `/spaces/${space.id}/members/${s.ayse.user.id}`)).status).toBe(200);
    expect((await call(app, s.ayse.token, 'GET', `/spaces/${space.id}/members`)).status).toBe(404);
    expect((await call(app, s.ali.token, 'POST', `/spaces/${s.company}/members`, { userId: s.veli.user.id })).status).toBe(400);
  });

  it('ayrılan çalışan: anahtarı kesilir, bağlayıcıları durur, oturum klasörü silinir, kayıt denetim günlüğünde', async () => {
    const s = await world(); const app = server();
    expect((await call(app, s.veli.token, 'POST', `/users/${s.ayse.user.id}/offboard`, { personal: 'delete' })).status).toBe(403);
    const res = await call(app, s.ali.token, 'POST', `/users/${s.veli.user.id}/offboard`, { personal: 'transfer', transferTo: s.ayse.user.id });
    expect(res.status).toBe(200);
    expect(res.json.stopped).toEqual([{ id: s.wa.id, kind: 'whatsapp' }]);
    expect(calls).toContain(`stop:${s.wa.id}`);
    expect((await call(app, s.veli.token, 'GET', '/me')).status).toBe(401);
    expect((await call(app, s.ayse.token, 'GET', '/search?q=gizli')).json).toHaveLength(1);
    expect((await call(app, s.ali.token, 'POST', `/users/${s.ali.user.id}/offboard`, { personal: 'delete' })).status).toBe(400);
    const users = (await call(app, s.ali.token, 'GET', '/users')).json;
    expect(users.find((u: any) => u.id === s.veli.user.id)).toMatchObject({ has_token: false });
    expect(users.find((u: any) => u.id === s.veli.user.id).disabled_at).toBeTruthy();
  });

  it('denetim kaydı yalnız yöneticiye açık ve yönetici işlemlerini içerir', async () => {
    const s = await world(); const app = server();
    await call(app, s.ali.token, 'POST', '/users', { name: 'Yeni Kişi' });
    await call(app, s.ali.token, 'POST', '/spaces', { name: 'Destek' });
    await call(app, s.ali.token, 'POST', '/accounts', { kind: 'telegram', label: 'Yeni bot', secrets: { botToken: 'x' } });
    expect((await call(app, s.veli.token, 'GET', '/audit')).status).toBe(403);
    const log = (await call(app, s.ali.token, 'GET', '/audit')).json;
    expect(log.map((l: any) => l.action)).toEqual(['account.create', 'space.create', 'user.create']);
    expect(log[0]).toMatchObject({ actor_name: 'Ali', target_type: 'account' });
    expect((await call(app, s.ali.token, 'GET', `/audit?before=${log[0].id}&limit=1`)).json).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain('botToken');
  });
});

describe('gizlilik: hariç tutma ve veri talepleri (API)', () => {
  it('hariç tutma listesi yönetilir; yeni mesajlar kaydedilmez, geçmiş temizlenir', async () => {
    const s = await world(); const app = server();
    await ingestMessage(ctx.db, s.tg.id, msg('group', 'g1', 'z1', 'Zeynep yazdı', { senderExternalId: '905551112233' }));
    expect((await call(app, s.veli.token, 'POST', '/exclusions', { identifier: '0555 111 22 33' })).status).toBe(403);
    const added = await call(app, s.ali.token, 'POST', '/exclusions', { identifier: '0555 111 22 33', label: 'Zeynep' });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ purged: 1, exclusion: { value: '905551112233' } });
    expect(await ingestMessage(ctx.db, s.tg.id, msg('group', 'g1', 'z2', 'tekrar', { senderExternalId: '905551112233' }))).toBe(false);
    expect((await call(app, s.ali.token, 'GET', '/exclusions')).json).toHaveLength(1);
    expect((await call(app, s.ali.token, 'DELETE', `/exclusions/${added.json.exclusion.id}`)).status).toBe(200);
    expect((await call(app, s.ali.token, 'DELETE', `/exclusions/${added.json.exclusion.id}`)).status).toBe(404);
  });

  it('KVKK dışa aktarma: yönetici kişisel alanı görmez; CSV indirilebilir; sıradan üye de kendi görebildiğini alır', async () => {
    const s = await world(); const app = server();
    await ingestMessage(ctx.db, s.tg.id, msg('group', 'g1', 'z1', 'ortak alandaki Zeynep mesajı', { senderExternalId: '905551112233' }));
    await ingestMessage(ctx.db, s.wa.id, msg('dm', '905551112233@s.whatsapp.net', 'z2', 'Veli ile özel', { senderExternalId: '905551112233@s.whatsapp.net' }));
    const admin = (await call(app, s.ali.token, 'POST', '/data-requests/export', { identifier: '+905551112233' })).json;
    expect(admin.messages.map((m: any) => m.body)).toEqual(['ortak alandaki Zeynep mesajı']);
    expect(admin.hidden_by_access).toBe(1);
    const csv = await call(app, s.ali.token, 'POST', '/data-requests/export', { identifier: '+905551112233', format: 'csv' });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('veri-talebi-');
    expect(csv.body).toContain('ortak alandaki Zeynep mesajı');
    expect(csv.body).not.toContain('özel');
    const own = (await call(app, s.veli.token, 'POST', '/data-requests/export', { identifier: '905551112233' })).json;
    expect(own.messages).toHaveLength(2);
  });

  it('KVKK silme: yalnız yönetici; kişisel alanlar dahil siler; içerik dönmez', async () => {
    const s = await world(); const app = server();
    await ingestMessage(ctx.db, s.wa.id, msg('dm', '905551112233@s.whatsapp.net', 'z2', 'Veli ile özel', { senderExternalId: '905551112233@s.whatsapp.net' }));
    expect((await call(app, s.veli.token, 'POST', '/data-requests/erase', { identifier: '905551112233' })).status).toBe(403);
    const res = await call(app, s.ali.token, 'POST', '/data-requests/erase', { identifier: '905551112233', exclude: true, note: 'başvuru 7' });
    expect(res.json).toEqual({ messages: 1, conversations: 1, excluded: true });
    expect(res.body).not.toContain('özel');
    expect((await call(app, s.veli.token, 'GET', '/search?q=özel')).json).toHaveLength(0);
    expect((await call(app, s.ali.token, 'GET', '/audit')).json[0]).toMatchObject({ action: 'data.erase' });
  });

  it('veri talepleri hız sınırlıdır', async () => {
    const s = await world(); const app = server({ sensitivePerMinute: 2 });
    const req = () => call(app, s.ali.token, 'POST', '/data-requests/export', { identifier: '905551112233' });
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429);
  });

  it('şirket botuna bilgilendirme ayarı kabul edilir; geçersiz istek 400 döner', async () => {
    const s = await world(); const app = server();
    const ok = await call(app, s.ali.token, 'POST', '/accounts', { kind: 'telegram', label: 'Bildirimsiz', config: { notice: false }, secrets: { botToken: 'x' } });
    expect(ok.status).toBe(201);
    const cfg = (await ctx.db.query('SELECT config FROM accounts WHERE id = $1', [ok.json.id])).rows[0] as any;
    expect(cfg.config).toEqual({ notice: false });
    expect((await call(app, s.ali.token, 'POST', '/accounts', { kind: 'telegram', label: 'x', config: { notice: 5 }, secrets: { botToken: 'x' } })).status).toBe(400);
  });
});
