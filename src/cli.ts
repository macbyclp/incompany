import { loadKeyring } from './config.js';
import { rotateSecrets } from './core/accounts.js';
import { audit } from './core/audit.js';
import { migrate, pgDb } from './db/client.js';
import { createUser } from './core/users.js';

const usage = `Kullanım:
  npm run cli -- create-admin "Ad Soyad" [e-posta]
  npm run cli -- rotate-secrets     (APP_SECRET'ı değiştirdikten sonra; eskisi APP_SECRET_PREVIOUS'ta durmalı)`;

const [cmd, name, email] = process.argv.slice(2);
if (cmd !== 'create-admin' && cmd !== 'rotate-secrets') {
  console.error(usage);
  process.exit(1);
}
if (cmd === 'create-admin' && !name) {
  console.error(usage);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL gerekli');
const db = pgDb(url);
await migrate(db);

if (cmd === 'create-admin') {
  const { user, token } = await createUser(db, { name: name!, email, isAdmin: true });
  console.log(`Yönetici oluşturuldu: #${user.id} ${user.name}`);
  console.log(`API token (bir daha gösterilmez): ${token}`);
} else {
  const { total, rotated } = await rotateSecrets(db, loadKeyring(process.env));
  await audit(db, null, 'secrets.rotate', { type: 'accounts' }, { total, rotated });
  console.log(`${total} kayıttan ${rotated} tanesi güncel anahtarla yeniden şifrelendi.`);
  if (rotated === 0) console.log('Hepsi zaten güncel anahtarla şifreli.');
  else console.log('Doğruladıktan sonra APP_SECRET_PREVIOUS değerini kaldırabilirsiniz.');
}
await db.close();
