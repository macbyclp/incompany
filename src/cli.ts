import { migrate, pgDb } from './db/client.js';
import { createUser } from './core/users.js';

// Kullanım: npm run cli -- create-admin "Ad Soyad" ali@firma.com
const [cmd, name, email] = process.argv.slice(2);
if (cmd !== 'create-admin' || !name) {
  console.error('Kullanım: npm run cli -- create-admin "Ad Soyad" [e-posta]');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL gerekli');
const db = pgDb(url);
await migrate(db);
const { user, token } = await createUser(db, { name, email, isAdmin: true });
console.log(`Yönetici oluşturuldu: #${user.id} ${user.name}`);
console.log(`API token (bir daha gösterilmez): ${token}`);
await db.close();
