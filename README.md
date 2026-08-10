# iNCompany

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.17-brightgreen)](package.json)

Kurumsal iç iletişim için uçtan uca güvenli, ölçeklenebilir ve modüler açık kaynak mesajlaşma platformu.

Bu depo bir **teknik dokümantasyon ve uygulama rehberidir**: mimari kararlar gerekçeleriyle yazılmış, veritabanı şemaları uygulanabilir DDL olarak verilmiş, tüm kritik yollar üretim standardında kodlanmıştır.

Katkıda bulunmak için [CONTRIBUTING.md](CONTRIBUTING.md), güvenlik açığı bildirimi için [SECURITY.md](SECURITY.md) dosyasına bakın. MIT lisansı ile dağıtılır.

---

## Durum

Tüm workspace **derleniyor ve testleri geçiyor**:

| Kontrol | Sonuç |
|---|---|
| `npm run typecheck` (3 paket) | ✅ temiz |
| `npm test` — backend | ✅ 57/57 |
| `npm test` — frontend | ✅ 17/17 |
| `npm run build` | ✅ `backend/dist/main.js`, `frontend/dist/` |

---

## Depo Yapısı

npm workspaces. `packages/contracts` hem backend hem frontend tarafından kullanılır — bu yüzden ayrı bir paket olarak derlenip `node_modules` üzerinden sembolik bağla çözülür. `tsconfig` `include`'u ile dışarıdan kaynak çekmek, TypeScript'in ortak kök dizinini yukarı kaydırmasına ve `dist/backend/src/main.js` gibi beklenmedik bir çıktıya yol açar.

```
incompany/
├── package.json          workspace kökü
├── packages/contracts/   paylaşılan event sözleşmesi (CJS'e derlenir)
├── backend/              NestJS API + realtime gateway
├── frontend/             React SPA
├── db/                   PostgreSQL DDL + ScyllaDB CQL
└── docs/                 mimari dokümantasyonu
```

**Docker derleme bağlamı depo köküdür**, alt dizin değil: `docker build -f backend/Dockerfile .`

---

## Hızlı Başlangıç

### Tek komut

```bash
./setup.sh          # Linux / macOS
```
```powershell
.\setup.ps1          # Windows
```

Bağımlılıkları kurar, `.env`'i örnekten üretir ve **tüm sırları otomatik
doldurur** (openssl varsa onu kullanır, yoksa `/dev/urandom`'a düşer),
paylaşılan sözleşme paketini derler ve tip kontrolüyle kurulumu doğrular.
Hem `openssl rand -base64` hem de betiğin ürettiği değer **gerçekten
çalıştırılıp doğrulanmıştır** — CRLF sızıntısı ve boru hattı kilitlenmesi
gibi platforma özgü iki hata bu doğrulama sırasında bulunup düzeltildi.

`.env` zaten varsa dokunulmaz — betik tekrar çalıştırmak güvenlidir.

Kurulumdan sonra:

```bash
npm run demo               # Docker olmadan hızlı deneme (terminal 1)
npm run demo:frontend      # terminal 2
```

veya tam ortam için (PostgreSQL + Redis + MinIO, Docker gerekir):

```bash
npm run docker:up
```

### Elle adımlar

Otomatik betiği kullanmak istemezseniz:

```bash
cp .env.example .env
```

Sırları üret ve `.env` içine yaz — **erişim ve refresh sırları farklı olmalı**, uygulama eşitse başlamaz:

```bash
openssl rand -base64 48
```

Şifreleme master anahtarı (yalnızca geliştirme; üretimde AWS KMS / Vault):

```bash
openssl rand -base64 32
```

Bağımlılıkları **kökten** kur (workspace):

```bash
npm install
```

Paylaşılan sözleşmeyi derle — backend buna `node_modules` üzerinden erişir:

```bash
npm run build --workspace @incompany/contracts
```

Ortamı ayağa kaldır:

```bash
docker compose up -d
```

| Servis | Adres |
|---|---|
| Frontend | http://localhost:5173 |
| API | http://localhost:3000/api/v1 |
| WebSocket | ws://localhost:3000/ws |
| Sağlık | http://localhost:3000/health/ready |
| MinIO Console | http://localhost:9001 |

Testler (kökten, tüm paketler):

```bash
npm test
```

---

## Dokümantasyon

| Adım | Doküman | İçerik |
|---|---|---|
| **1** | [Sistem Mimarisi ve Şema](docs/01-mimari.md) | Mimari kararlar ve gerekçeleri, teknoloji yığını, ASCII mimari şeması, ERD, şema tasarım kararları, **E2EE ↔ uyum gerilimi** |
| **2** | [Gerçek Zamanlı Mimari](docs/02-realtime.md) | Event sözleşmesi, yatay ölçekleme, presence, boşluk doldurma, backpressure, kapasite tahmini |
| **3–4** | Backend / Frontend kodu | Aşağıdaki dosya haritası |
| **5** | [Dağıtım ve Sertleştirme](docs/05-dagitim-ve-sertlestirme.md) | Üretim topolojisi, **5 kritik güvenlik önlemi**, üretime geçiş kapısı |

---

## Kod Haritası

### Veritabanı

| Dosya | İçerik |
|---|---|
| [`db/postgres/001_schema.sql`](db/postgres/001_schema.sql) | Tam DDL: `users`, `departments`, `channels`, `channel_members`, `messages` (partitioned), `audit_logs` (hash zincirli, ekle-yalnız), RBAC, DLP, retention, outbox, RLS |
| [`db/scylla/001_messages.cql`](db/scylla/001_messages.cql) | Ölçek geçişi için sorgu odaklı mesaj deposu şeması |

### Backend — NestJS · TypeScript

**Kimlik ve yetki**

| Dosya | Rol |
|---|---|
| [`auth/auth.service.ts`](backend/src/auth/auth.service.ts) | Oturum açma, **refresh rotasyonu + yeniden kullanım tespiti**, çıkış, oturum listesi |
| [`auth/guards/jwt-auth.guard.ts`](backend/src/auth/guards/jwt-auth.guard.ts) | Algoritma beyaz listesi, jti denylist, `token_version` ile toplu iptal |
| [`auth/guards/roles.guard.ts`](backend/src/auth/guards/roles.guard.ts) | Hiyerarşik roller + ince taneli izinler; her ret denetime yazılır |
| [`auth/sso/sso.service.ts`](backend/src/auth/sso/sso.service.ts) | OIDC Authorization Code + PKCE, nonce doğrulaması, açık yönlendirme koruması |
| [`auth/token-denylist.service.ts`](backend/src/auth/token-denylist.service.ts) | JWT iptali — fail-closed |
| [`auth/user-security.cache.ts`](backend/src/auth/user-security.cache.ts) | İki katmanlı önbellek (L1 süreç 5 sn / L2 Redis 30 sn) |
| [`auth/auth.controller.ts`](backend/src/auth/auth.controller.ts) | SSO akışı, httpOnly refresh çerezi, cihaz yönetimi |

**Mesajlaşma**

| Dosya | Rol |
|---|---|
| [`chat/chat.gateway.ts`](backend/src/chat/chat.gateway.ts) | WebSocket gateway — handshake doğrulama, tembel oda katılımı, rate limit, token süre denetimi |
| [`chat/chat.service.ts`](backend/src/chat/chat.service.ts) | idempotency → yetki → sanitize → DLP → şifreleme → kalıcılık |
| [`chat/message.repository.ts`](backend/src/chat/message.repository.ts) | Atomik `seq` atama + outbox, tek transaction |
| [`chat/sanitize.ts`](backend/src/chat/sanitize.ts) | XSS, bidi override (Trojan Source), sıfır genişlikli karakter, NFC |
| [`chat/dto.ts`](backend/src/chat/dto.ts) | Yük doğrulama — kütle atama saldırısını kapatır |

**Şifreleme**

| Dosya | Rol |
|---|---|
| [`common/crypto/crypto.service.ts`](backend/src/common/crypto/crypto.service.ts) | AES-256-GCM zarf şifreleme, DEK önbelleği, AAD bağlama, rotasyon |
| [`common/crypto/key-management.service.ts`](backend/src/common/crypto/key-management.service.ts) | KMS soyutlaması — yerel (dev) ve AWS KMS (üretim) |
| [`common/crypto/channel-key.repository.ts`](backend/src/common/crypto/channel-key.repository.ts) | Sarmalanmış DEK depolama ve sürümleme |

**Güvenlik ve uyum**

| Dosya | Rol |
|---|---|
| [`dlp/dlp.service.ts`](backend/src/dlp/dlp.service.ts) | İki aşamalı eşleştirme, maskeleme, olay kaydı |
| [`dlp/validators.ts`](backend/src/dlp/validators.ts) | TCKN (NVİ algoritması), Luhn, IBAN mod-97 |
| [`audit/audit.service.ts`](backend/src/audit/audit.service.ts) | Kritik senkron / hacimli toplu yazım, hash zinciri doğrulaması, PII redaksiyonu |
| [`channels/channel-policy.service.ts`](backend/src/channels/channel-policy.service.ts) | Kanal kapsamlı ABAC — duyuru kısıtı, kiracı sınırı |
| [`files/files.service.ts`](backend/src/files/files.service.ts) | Presigned upload, AV kapısı, çift uzantı koruması |
| [`retention/retention.service.ts`](backend/src/retention/retention.service.ts) | `DROP PARTITION` ile silme, legal hold, anahtar rotasyonu, advisory lock |

**Altyapı**

| Dosya | Rol |
|---|---|
| [`main.ts`](backend/src/main.ts) | CSP, CORS beyaz listesi, Redis Streams adapter, graceful shutdown |
| [`app.module.ts`](backend/src/app.module.ts) | Zod ile ortam doğrulaması, global guard sırası |
| [`common/database/database.service.ts`](backend/src/common/database/database.service.ts) | Havuz, transaction, `SET LOCAL` ile RLS kiracı bağlamı |
| [`common/rate-limit/rate-limiter.service.ts`](backend/src/common/rate-limit/rate-limiter.service.ts) | Lua ile atomik kayan pencere, fail-open/fail-closed varyantları |
| [`common/filters/`](backend/src/common/filters/) | Yığın izi sızıntısını durduran HTTP ve WS hata filtreleri |

### Frontend — React 18 · TypeScript · Zustand · Tailwind

| Dosya | Rol |
|---|---|
| [`store/chat.store.ts`](frontend/src/store/chat.store.ts) | Normalize mesajlar, iyimser gönderim, boşluk tespiti, kararlı seçiciler |
| [`store/auth.store.ts`](frontend/src/store/auth.store.ts) | Bellekte token, tekilleştirilmiş yenileme |
| [`store/directory.store.ts`](frontend/src/store/directory.store.ts) | Toplu kullanıcı çözümleme |
| [`realtime/socket.ts`](frontend/src/realtime/socket.ts) | Yeniden bağlanma, token yenileme, senkronizasyon, ack zaman aşımı |
| [`components/ChatWindow.tsx`](frontend/src/components/ChatWindow.tsx) | Sanallaştırma, kaydırma çapası, okundu imleci |
| [`components/MessageInput.tsx`](frontend/src/components/MessageInput.tsx) | IME desteği, kısıtlı yazıyor sinyali, taslak kalıcılığı |
| [`components/MessageBubble.tsx`](frontend/src/components/MessageBubble.tsx) | Markdown + DOMPurify, durum göstergesi |

### Paylaşılan

[`packages/contracts/src/events.ts`](packages/contracts/src/events.ts) — backend ve frontend'in **paylaştığı** event sözleşmesi. Bir event değiştiğinde her iki taraf da derleme zamanında kırılır.

---

## Mimarinin Üç Temel Kararı

### 1. Modüler monolit, gün-1 mikroservis değil

Kullanıcı tavanı bellidir (10K–100K çalışan). Bu ölçekte erken mikroservis, dağıtık transaction ve operasyonel yükü karşılıksız getirir. Yalnızca ölçekleme profili gerçekten farklı olan iki bileşen ayrılır: **Realtime Gateway** (bağlantı sayısına göre ölçeklenir) ve **Worker**.

### 2. `seq` — kanal içi monotonik sıra numarası

Zaman damgası sıralama için yetmez: sunucu saatleri kayar, aynı milisaniyede iki mesaj gelir. `next_channel_seq()` atomik olarak artan bir sayaç verir. İstemci *"41'den 55'e atladım"* diyerek kaybı tespit eder ve yalnızca eksik aralığı ister.

### 3. E2EE ↔ uyum gerilimi açıkça yönetilir

> Gerçek uçtan uca şifreleme ile sunucu taraflı DLP, arama ve e-keşif **aynı anda mümkün değildir.**

- **Mod A (varsayılan):** AES-256-GCM zarf şifreleme. DB sızıntısına karşı korur; DLP, arama ve arşivleme çalışır.
- **Mod B (opsiyonel):** Gerçek E2EE. Ele geçirilmiş sunucuya karşı da korur; DLP ve arama yapısal olarak imkânsız hale gelir.

Mod B kanal oluşturulurken *geri alınamaz* şekilde seçilir (şemada trigger ile korunur). Ayrıntı: [docs/01-mimari.md §1.4](docs/01-mimari.md).

---

## Modül Durumu

| Modül | Durum |
|---|---|
| Kimlik doğrulama & RBAC | ✅ JWT + refresh rotasyonu + yeniden kullanım tespiti, hiyerarşik roller, izin sistemi, iptal edilebilirlik |
| SSO (OIDC + PKCE) | ✅ Yetkilendirme, callback, nonce/state doğrulaması. SAML için kütüphane önerisi belgelendi |
| Kanal & mesaj yönetimi | ✅ DM, grup, departman, duyuru; yanıt, konu başlığı, bahsetme, düzenleme, silme |
| Mesaj durumları | ✅ Gönderildi / iletildi / okundu (yüksek-su-seviyesi), yazıyor göstergesi |
| Dosya paylaşımı | ✅ Presigned upload, checksum doğrulaması, AV kapısı, çift uzantı koruması |
| DLP | ✅ TCKN, kredi kartı, IBAN, AWS anahtarı, PEM, JWT; maskeleme ve engelleme |
| Denetim izi | ✅ Ekle-yalnız + hash zinciri + DB seviyesinde koruma + doğrulama görevi |
| Saklama politikaları | ✅ `DROP PARTITION`, legal hold, dosya TTL, planlı görevler |
| Presence | ✅ TTL tabanlı, çoklu cihaz, özel durum, keyspace bildirimleri |
| Ayarlar | ✅ Profil, tema (açık/koyu/sistem), bildirimler + sessiz saatler, durum, etkin oturumlar |
| Kullanıcı yönetimi | ✅ Listeleme, oluşturma, rol atama, askıya alma. Parola YOK — provizyon SSO içindir |
| Kanal oluşturma | ✅ Grup / departman / duyuru, gizlilik, geri alınamaz E2EE uyarısıyla |
| DM başlatma | ✅ Kişi seçici, idempotent (aynı kişiyle ikinci DM açılmaz) |
| Üye yönetimi | ✅ Listeleme, ekleme, çıkarma; sahip/moderatör rozetleri, sahip çıkarılamaz |
| Mesaj düzenle/sil | ✅ Satır içi düzenleme (DLP yeniden taranır), silme onayı (kendi mesajı veya moderatör) |
| Arama (OpenSearch) | 📐 Outbox olayları üretiliyor; indeksleyici worker'ı yazılmadı |
| LDAP/AD doğrudan bağ | 📐 Şema hazır (`idp_provider`, `idp_subject`); OIDC üzerinden AD önerilir |

### Demoyu çalıştırma

Docker olmadan, gerçek kripto/DLP/sanitize koduyla (depolama bellekte), kökten:

```bash
npm run demo
```

Ayrı bir terminalde:

```bash
npm run demo:frontend
```

Sonra http://localhost:5173 açın. Sunucu konsolunda DLP denemesi için hazır
değerler yazılıdır (TCKN, kredi kartı, AWS anahtarı).

---

## Bilinen Sınırlar

Dürüst olmak gerekirse, aşağıdakiler bilinçli olarak dışarıda bırakıldı:

- **OpenSearch indeksleyici worker'ı** — outbox olayları yazılıyor, tüketici yok
- **AV tarama worker'ı** — `attachment.scan_requested` olayı üretiliyor, ClamAV entegrasyonu yok. Bu olmadan `av_status` `PENDING`'de kalır ve **hiçbir dosya indirilemez** (kasıtlı fail-closed davranış)
- **Presence yayını organizasyon geneli** — 10.000 kişilik bir kurumda her bağlantı 10.000 event üretir. ~1.000 kullanıcıya kadar yeterli; üstünde "ortak kanalı olanlar" olarak daraltılmalı ([`chat.gateway.ts` → `emitPresence`](backend/src/chat/chat.gateway.ts) içinde not edildi)
- **Seed betiği ve E2E testleri** — birim testleri kritik modülleri kapsıyor (kripto, DLP, sanitize, sohbet deposu), entegrasyon testi yok
- **Kubernetes manifestoları** — docker-compose geliştirme için hazır; üretim topolojisi [docs/05](docs/05-dagitim-ve-sertlestirme.md)'te belgelendi ama YAML'a dökülmedi
- **Docker imajları yerel olarak derlenmedi** — Dockerfile'lar workspace bağlamına göre yazıldı, ama `docker build` çalıştırılmadı

Kritik ve hata yapmaya en açık yollar — kripto, yetki, gerçek zamanlı tutarlılık, DLP, denetim — eksiksiz yazılmıştır.

---

## Testlerin Yakaladığı Bir Hata

`decryptBatch` testi, `CryptoService`'te gerçek bir eşzamanlılık hatası ortaya çıkardı ve bu, testlerin neden yazıldığının iyi bir örneği:

Soğuk önbellekte aynı kanala eşzamanlı N şifreleme yapıldığında, `resolveActiveDek` tek uçuş (single-flight) garantisi vermiyordu. Her çağrı kendi DEK nesnesini üretiyor, önbelleğe son yazan **önceki nesnenin tamponunu sıfırlıyordu** — o tamponu hâlâ tutan çağrılar sıfırlarla şifreliyor ve mesajlar kalıcı olarak okunamaz hale geliyordu.

Bu hata yalnızca eşzamanlılık altında, yalnızca önbellek soğukken ve **sessizce** ortaya çıkıyordu: yani üretimde her yeniden başlatmadan sonraki ilk saniyelerde, hiçbir hata fırlatmadan veri kaybı olarak. Düzeltme tek uçuş garantisi + kullanımdaki tamponu sıfırlamamak; `test/crypto.service.spec.ts` içinde açık regresyon testi var.

**Manuel demo testinin yakaladığı bir hata:** Üye çıkarma paneli kendi yerel listesini güncelliyordu ama kenar çubuğu/başlıktaki `memberCount` ayrı bir depoda (`channels.store`) tutulduğu için senkronize olmuyordu — panel kapatıldığında rozet eski (yanlış) sayıyı göstermeye devam ediyordu. Tip kontrolü ve testler bunu yakalayamazdı çünkü ikisi de derleme zamanında geçerli, çalışma zamanında yanlıştı. Düzeltme: `refreshChannels()` tek bir yere taşındı ve her mutasyondan (ekleme/çıkarma/oluşturma) sonra çağrılıyor — "tek doğruluk kaynağı" ilkesi.

---

## CI Kapıları

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) — hepsi bloklayıcı:

| Kapı | Ne yapar |
|---|---|
| Sır taraması | Gitleaks, tüm geçmiş üzerinde. Her şeyden önce çalışır |
| Lint + tip | `--max-warnings 0`, `tsc --noEmit` |
| Test + kapsam | Kritik modüllerde %90–100 eşik ([`vitest.config.ts`](backend/vitest.config.ts)) |
| Şema | Gerçek PostgreSQL'e uygulanır; **denetim tablosunun ekle-yalnız olduğu test edilir** |
| Bağımlılık | `npm audit --audit-level=high` + Trivy |
| Konteyner | Distroless imaj derlemesi + SBOM + provenance + CVE taraması |
