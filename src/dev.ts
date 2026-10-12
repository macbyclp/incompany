// Docker ve Postgres olmadan paneli denemek için: bellek içi veritabanı, sahte bağlayıcılar, örnek veri.
// Kullanım: npm run dev   (gerçek hesaplara bağlanmaz, hiçbir şey diske yazılmaz)
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from './api/server.js';
import { createAccount, getAccount, needsConsent, type AccountKind } from './core/accounts.js';
import { grantConsent } from './core/consent.js';
import { ingestMessage, moveConversation, type IncomingMessage } from './core/ingest.js';
import { createUser, ensureCompanySpace } from './core/users.js';
import { pgliteDb } from './db/pglite.js';

const SECRET = 'dev-secret-dev-secret-dev-secret';
const db = await pgliteDb();
const company = await ensureCompanySpace(db, 'Şirket');

const ali = await createUser(db, { name: 'Ali Yılmaz', email: 'ali@ornek.com', isAdmin: true });
const veli = await createUser(db, { name: 'Veli Demir', email: 'veli@ornek.com' });
await createUser(db, { name: 'Ayşe Kaya', email: 'ayse@ornek.com' });

const at = (daysAgo: number, hour = 10) => new Date(Date.now() - daysAgo * 86_400_000 + (hour - 12) * 3_600_000);
const m = (kind: IncomingMessage['conversation']['kind'], conv: string, title: string, id: string,
  sender: string, body: string, daysAgo: number, extra: Partial<IncomingMessage> = {}): IncomingMessage =>
  ({ conversation: { externalId: conv, kind, title }, externalId: id, senderName: sender, sentAt: at(daysAgo), body, ...extra });

const tg = await createAccount(db, SECRET, { kind: 'telegram', ownerUserId: ali.user.id, label: 'Şirket Telegram botu',
  defaultSpaceId: company, secrets: { botToken: 'demo' } });
const sl = await createAccount(db, SECRET, { kind: 'slack', ownerUserId: ali.user.id, label: 'Şirket Slack',
  defaultSpaceId: company, secrets: { botToken: 'demo', appToken: 'demo' } });
const wa = await createAccount(db, SECRET, { kind: 'whatsapp', ownerUserId: ali.user.id, label: 'Ali\'nin WhatsApp\'ı',
  defaultSpaceId: ali.personalSpaceId });
const mail = await createAccount(db, SECRET, { kind: 'email', ownerUserId: ali.user.id, label: 'ali@ornek.com',
  defaultSpaceId: ali.personalSpaceId, config: { host: 'imap.ornek.com', user: 'ali@ornek.com' }, secrets: { password: 'demo' } });
await db.query(`UPDATE accounts SET status = 'awaiting_consent' WHERE id = $1`, [mail.id]);
await grantConsent(db, wa.id, ali.user.id, { dm: 'selected', group: 'all', history: false });

const feed: Array<[number, IncomingMessage]> = [
  [tg.id, m('group', '-1001', 'Ürün ekibi', 't1', 'Veli Demir', 'Lansman tarihini 24 Ekim olarak kilitledik, tasarım teslimi çarşamba.', 2)],
  [tg.id, m('group', '-1001', 'Ürün ekibi', 't2', 'Ayşe Kaya', 'Fiyatlandırma sayfası için üç paket öneriyorum: Başlangıç, Takım, Şirket.', 2)],
  [tg.id, m('group', '-1001', 'Ürün ekibi', 't3', 'Ali Yılmaz', 'Müşteri görüşmelerinden çıkan en büyük istek: toplantı notlarının otomatik özeti.', 1)],
  [sl.id, m('channel', 'C01', '#satış', 's1', 'Veli Demir', 'Demir Lojistik teklifi onaylandı, sözleşme cuma günü imzalanacak.', 3)],
  [sl.id, m('channel', 'C01', '#satış', 's2', 'Ayşe Kaya', 'Yeni potansiyel müşteri listesi paylaşıldı, ilk 20 kişiyi bu hafta arayalım.', 1)],
  [sl.id, m('channel', 'C02', '#destek', 's3', 'Ayşe Kaya', 'Faturalama hatası bildirimi: iki müşteride çift tahsilat görünüyor.', 0)],
  [wa.id, m('group', '905001@g.us', 'Proje koordinasyon', 'w1', 'Mehmet', 'Sunucu taşıma işi pazar gecesi 02:00\'de başlıyor, 3 saat kesinti olacak.', 4)],
  [wa.id, m('group', '905001@g.us', 'Proje koordinasyon', 'w2', 'Mehmet', 'Yedekleri perşembe akşamı doğruladım, sorun yok.', 1)],
  [wa.id, m('dm', '905002@s.whatsapp.net', 'Zeynep (tedarikçi)', 'w3', 'Zeynep', 'Fiyat listesi güncellendi, yüzde sekiz artış var.', 1)],
];
for (const [acc, msg] of feed) await ingestMessage(db, acc, msg);
// Telegram grubunu ve Slack kanallarını şirket alanına zaten bot hesabı yazıyor; WhatsApp grubunu sahibi açıkça paylaşıyor.
const waGroup = (await db.query<{ id: number }>(`SELECT id FROM conversations WHERE external_id = '905001@g.us'`)).rows[0]!;
await moveConversation(db, Number(waGroup.id), company);

// Sahte bağlayıcı kontrolü.
const connectors = {
  async start(id: number) {
    const acc = (await getAccount(db, id))!;
    if (needsConsent(acc.kind) && !acc.consent_at) return;
    const status = acc.kind === 'whatsapp' ? 'awaiting_qr' : acc.kind === 'email' ? 'connected' : 'connected';
    await db.query('UPDATE accounts SET status = $2 WHERE id = $1', [id, status]);
  },
  async stop() {},
  pairingQr: (id: number) => `incompany-demo-eslestirme-${id}-${Math.floor(Date.now() / 20_000)}`,
  sessionDir: (kind: AccountKind, id: number) => join(tmpdir(), 'incompany-dev', kind, String(id)),
};
for (const a of [tg, sl, wa]) await connectors.start(a.id);

const port = Number(process.env.PORT ?? 3000);
const app = buildServer({ db, appSecret: SECRET, connectors, logger: false });
await app.listen({ host: '127.0.0.1', port });
console.log(`\nincompany demo paneli: http://localhost:${port}`);
console.log(`Yönetici token: ${ali.token}`);
console.log(`Üye token (Veli): ${veli.token}\n`);
