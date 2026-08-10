# Adım 1 — Sistem Mimarisi ve Şema Tasarımı

## 1.1 Mimari Kararı: Modüler Monolit → Mikroservis

**Karar: Modüler monolit ile başla, iki servisi baştan ayır.**

Kurumsal iç iletişim platformunun kullanıcı tavanı bellidir (10K–100K çalışan, eş zamanlı %20–30). Bu ölçekte gün-1 mikroservis, dağıtık transaction ve operasyonel yükü kazanç sağlamadan getirir. Ancak iki bileşen baştan ayrı süreç olarak çalışmalıdır:

| Bileşen | Neden ayrı? |
|---|---|
| **Realtime Gateway** (WebSocket) | Ölçekleme profili tamamen farklı: bağlantı sayısına (memory/fd) göre ölçeklenir, CPU'ya göre değil. HTTP API ile aynı pod'da olması gereksiz yere API replikalarını da şişirir. |
| **Worker / Consumer** | Retention silme, Elasticsearch indeksleme, audit sink, virüs taraması gibi işler istek yolunu bloklamamalı. |

Geri kalan her şey (Auth, Channels, Messages, DLP, Audit, Admin) tek deploy edilebilir NestJS uygulamasında **modül sınırlarıyla** ayrılır. Modüller yalnızca kendi servis arayüzleri üzerinden konuşur; başka modülün repository'sine doğrudan erişim yasaktır. Bu disiplin korunursa bir modülü mikroservise çıkarmak mekanik bir işlemdir.

## 1.2 Teknoloji Yığını ve Gerekçeleri

| Katman | Seçim | Gerekçe |
|---|---|---|
| Backend | **NestJS (Node 20, TypeScript)** | Guard/Interceptor/DI birinci sınıf; WebSocket Gateway ile HTTP katmanı aynı DI ağacını paylaşır — yetki mantığı tek yerde yazılır. Frontend ile tip paylaşımı (`@incompany/contracts`) mümkün. |
| Realtime | **Socket.IO + Redis Streams Adapter** | Otomatik reconnect, ack/callback, room semantiği ve fallback hazır. Ham WebSocket'te bunların hepsi elle yazılır. gRPC streaming tarayıcıda proxy gerektirir. |
| İlişkisel veri | **PostgreSQL 16** | Kullanıcı/departman/RBAC verisi transactional ve düşük hacimli. RLS (Row Level Security) ile tenant izolasyonu veritabanı seviyesinde zorlanabilir. |
| Mesaj geçmişi | **PostgreSQL (partitioned) → ScyllaDB** | Aşağıda ayrıntı. |
| Cache / Presence | **Redis 7 (Cluster)** | Presence TTL, rate limit sayaçları, JWT denylist, Socket.IO adapter — hepsi tek altyapıda. |
| Arama | **OpenSearch / Elasticsearch 8** | Türkçe analyzer, per-user ACL filtreli sorgu. |
| Event bus | **Redis Streams (MVP) → Kafka** | Audit ve analytics için dayanıklı log gerektiğinde Kafka. |
| Frontend | **React 18 + TypeScript + Vite + Zustand + TailwindCSS** | Zustand, Redux Toolkit'e göre saniyede yüzlerce mesaj event'i altında daha az boilerplate ve seçici (selective) subscription ile daha az yeniden render. |
| Object storage | **S3 uyumlu (MinIO / AWS S3)** | Dosyalar asla DB'ye yazılmaz; presigned URL ile doğrudan yükleme. |
| Secret / Key | **HashiCorp Vault veya AWS KMS** | Master key (KEK) uygulama sürecinde asla kalıcı tutulmaz. |

### Mesaj deposu seçimi — dürüst değerlendirme

ScyllaDB/Cassandra doğru uzun vadeli seçimdir (append-heavy, partition key = `channel_id`, clustering = zaman) fakat **gün-1'de gereksizdir.** 10.000 kişilik bir kurumda günde ~500K mesaj = yılda ~180M satır. PostgreSQL'de `RANGE` partitioned tablo bunu rahatlıkla taşır ve tek bir veritabanı ile transactional tutarlılık kazanırsınız.

**Geçiş eşiği:** aylık partition > 100M satır **veya** p99 kanal okuma gecikmesi > 150 ms. Bu nedenle `MessageRepository` bir arayüz olarak tanımlanır; `PostgresMessageRepository` ve `ScyllaMessageRepository` aynı sözleşmeyi uygular ve geçiş konfigürasyonla yapılır. Her iki şema da bu repoda mevcuttur (`db/postgres/`, `db/scylla/`).

## 1.3 Yüksek Seviye Mimari

```
                            ┌──────────────────────────┐
   Kurumsal Ağ / VPN        │   Kimlik Sağlayıcı (IdP)  │
   ─────────────────        │  Azure AD / Okta / ADFS   │
                            │  SAML 2.0 · OIDC · LDAP   │
                            └────────────┬─────────────┘
                                         │ OIDC Auth Code + PKCE
                                         ▼
 ┌──────────┐   HTTPS/WSS   ┌────────────────────────────────────────┐
 │  Web SPA │──────────────▶│  Edge:  WAF → L7 LB (sticky: none)     │
 │  Desktop │               │  mTLS terminasyonu, TLS 1.3, HSTS      │
 │  Mobile  │◀──────────────│  Rate limit (IP + tenant)              │
 └──────────┘               └───────┬──────────────────┬─────────────┘
                                    │ /api/*           │ /socket.io/*
                        ┌───────────▼──────┐   ┌───────▼────────────────┐
                        │   API Servisi     │   │  Realtime Gateway      │
                        │   (NestJS HTTP)   │   │  (NestJS WS · N replika)│
                        │                   │   │                        │
                        │ Auth · RBAC       │   │ Bağlantı başına:       │
                        │ Channels · Files  │   │  · JWT doğrulama       │
                        │ Admin · Search    │   │  · room join (kanal)   │
                        │ DLP · Audit       │   │  · presence heartbeat  │
                        └────┬────┬────┬────┘   └───┬──────────┬─────────┘
                             │    │    │            │          │
        ┌────────────────────┘    │    └──────┐     │          │
        ▼                         ▼           ▼     ▼          ▼
 ┌─────────────┐  ┌────────────────────┐  ┌──────────────┐  ┌──────────────┐
 │ PostgreSQL  │  │ Mesaj Deposu       │  │   Redis 7    │  │  S3 / MinIO  │
 │ (Primary +  │  │ PG partitioned  ⇄  │  │  Cluster     │  │  (SSE-KMS)   │
 │  Read Rep.) │  │ ScyllaDB           │  │              │  │  Presigned   │
 │             │  │                    │  │ · presence   │  │  URL         │
 │ users       │  │ messages_by_channel│  │ · pub/sub    │  └──────────────┘
 │ departments │  │ read_state         │  │ · adapter    │
 │ channels    │  │ attachments_meta   │  │ · ratelimit  │
 │ rbac        │  └────────────────────┘  │ · jti deny   │
 │ audit_logs  │                          └──────────────┘
 └─────────────┘
        │                                        │
        │  outbox (CDC / Debezium)                │ Redis Streams → Kafka
        ▼                                        ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │                       Worker / Consumer Havuzu                    │
 │  · Search indexer (OpenSearch)   · Retention & purge cron        │
 │  · Audit sink (WORM / S3 Object Lock)                            │
 │  · Bildirim (Push/E-posta)       · ClamAV dosya taraması         │
 └──────────────────────────────────────────────────────────────────┘
                    │                             │
                    ▼                             ▼
            ┌───────────────┐            ┌──────────────────┐
            │  OpenSearch   │            │  SIEM (Splunk /  │
            │  (ACL filtre) │            │  Sentinel) + WORM│
            └───────────────┘            └──────────────────┘

 Anahtar yönetimi:  Vault / AWS KMS  ──(KEK, asla diske yazılmaz)──▶ API & Gateway
 Gözlemlenebilirlik: OpenTelemetry → Prometheus + Loki + Tempo → Grafana
```

### Mesaj gönderiminin uçtan uca yolu

```
 Client                Gateway              DLP        Crypto      Store       Redis        Diğer Client
   │  message:send        │                  │           │           │           │                │
   ├─────────────────────▶│                  │           │           │           │                │
   │                      │ 1. rate limit    │           │           │           │                │
   │                      │ 2. üyelik+yetki  │           │           │           │                │
   │                      │ 3. idempotency   │           │           │           │                │
   │                      ├─ tara ──────────▶│           │           │           │                │
   │                      │◀─ ALLOW/MASK/BLOCK│          │           │           │                │
   │                      ├─ şifrele ────────────────────▶           │           │                │
   │                      │◀─ AES-256-GCM zarfı ─────────┤           │           │                │
   │                      ├─ kaydet (seq ata) ───────────────────────▶           │                │
   │  ack{id,seq,ts}      │◀─────────────────────────────────────────┤           │                │
   │◀─────────────────────┤                  │           │           │           │                │
   │                      ├─ room yayını ────────────────────────────────────────▶ message:new ──▶│
   │                      ├─ outbox → indexer / audit / push                      │                │
```

**Neden bu sıra?** DLP şifrelemeden **önce** çalışmalı (şifreli veri taranamaz). Ack, yayından **önce** dönmeli (gönderenin UI'ı en hızlı şekilde optimistic state'ten çıksın). Persist, ack'ten **önce** olmalı (kaybolan mesaj kabul edilemez — "at-least-once" garantisi).

## 1.4 Kritik Mimari Gerilim: E2EE ↔ Uyum (Compliance)

Bu, tasarımın en önemli kararıdır ve net olarak belgelenmelidir:

> **Gerçek uçtan uca şifreleme ile sunucu taraflı DLP, arama ve e-keşif (eDiscovery) aynı anda mümkün değildir.** Sunucu düz metni göremiyorsa tarayamaz da, indeksleyemez de.

Bu yüzden iki mod tanımlanır ve kanal bazında seçilir:

| | **Mod A — Sunucu Tarafı Şifreleme (varsayılan)** | **Mod B — Gerçek E2EE (opsiyonel)** |
|---|---|---|
| Şifreleme | AES-256-GCM, zarf (envelope) şeması, DEK Vault/KMS ile sarmalanır | Signal Protocol (X3DH + Double Ratchet) veya MLS (RFC 9420) |
| Anahtar sahibi | Sunucu (KMS aracılığıyla) | Yalnızca istemci cihazları |
| DLP | ✅ Tam | ❌ Yalnızca istemci tarafı (bypass edilebilir → caydırıcı, engelleyici değil) |
| Sunucu tarafı arama | ✅ OpenSearch | ❌ Sadece istemci yerel indeksi |
| eDiscovery / yasal talep | ✅ | ❌ (opsiyonel "denetim üyesi" cihazı gerekir) |
| Koruduğu tehdit | DB sızıntısı, yedek çalınması, disk erişimi, DBA merakı | Yukarıdakiler **+ ele geçirilmiş sunucu** |
| Kullanım | Tüm normal kurumsal iletişim | Hukuk, İK soruşturma, M&A, yönetim kurulu kanalları |

**Öneri:** Varsayılan Mod A. Mod B, kanal oluşturulurken *geri alınamaz* şekilde seçilir ve arayüzde "bu kanal aranamaz ve arşivlenemez" uyarısı açıkça gösterilir. Mod B'yi organizasyon genelinde varsayılan yapmak, KVKK/SOX/HIPAA kapsamındaki saklama ve denetim yükümlülüklerini karşılayamaz hale getirir.

Bu doküman ve kod tabanı **Mod A**'yı tam olarak uygular; Mod B için anahtar dağıtım iskeleti (`device_keys`, `prekey_bundles`) şemada yer alır.

## 1.5 ERD (Varlık-İlişki Diyagramı)

```
 ┌──────────────────┐
 │  organizations   │  (tenant kökü — tüm tablolarda org_id)
 └────────┬─────────┘
          │ 1:N
    ┌─────┴──────────────────────────────────────────┐
    ▼                                                ▼
 ┌──────────────┐  N:1 (parent_id, ağaç)      ┌──────────────┐
 │ departments  │◀──┐                          │    users     │
 │              │───┘                          │              │
 │ manager_id   │──────────────────────────────▶│ department_id│
 └──────┬───────┘         N:1                  └──────┬───────┘
        │                                              │
        │                                              │ N:M
        │                                        ┌─────▼────────┐    ┌────────┐
        │                                        │  user_roles  │───▶│ roles  │
        │                                        └──────────────┘    └───┬────┘
        │                                                                │ N:M
        │                                                        ┌───────▼──────────┐
        │                                                        │ role_permissions │
        │                                                        └───────┬──────────┘
        │                                                                ▼
        │                                                        ┌──────────────┐
        │                                                        │ permissions  │
        │                                                        └──────────────┘
        │ 1:N (departman kanalı)
        ▼
 ┌──────────────┐   1:N    ┌──────────────────┐   N:1   ┌──────────────┐
 │   channels   │─────────▶│ channel_members  │────────▶│    users     │
 │              │          │  role, muted,    │         └──────────────┘
 │ type:        │          │  last_read_seq   │
 │  DM|GROUP|   │          └──────────────────┘
 │  DEPARTMENT| │
 │  ANNOUNCEMENT│   1:N    ┌──────────────────┐
 │              │─────────▶│    messages      │──┐ self-ref: reply_to_id / thread_root_id
 │ e2ee_enabled │          │  (PARTITIONED)   │◀─┘
 │ retention_id │          │  seq, ciphertext │
 └──────┬───────┘          └────────┬─────────┘
        │                           │ 1:N
        │ 1:1                       ▼
        ▼                  ┌──────────────────┐      ┌──────────────────┐
 ┌──────────────┐          │  message_files   │─────▶│   attachments    │
 │ channel_keys │          └──────────────────┘      │  (S3 key, AV)    │
 │ (wrapped DEK)│                                    └──────────────────┘
 └──────────────┘          ┌──────────────────┐
                           │ message_reactions│
 ┌──────────────────┐      └──────────────────┘
 │ retention_policies│
 └──────────────────┘      ┌──────────────────┐      ┌──────────────────┐
                           │    dlp_rules     │─────▶│ dlp_incidents    │
 ┌──────────────────┐      └──────────────────┘      └──────────────────┘
 │   audit_logs     │
 │  (PARTITIONED,   │      ┌──────────────────┐
 │   append-only)   │      │ refresh_sessions │  (rotation + reuse detection)
 └──────────────────┘      └──────────────────┘
```

Tam DDL: [`db/postgres/001_schema.sql`](../db/postgres/001_schema.sql)
ScyllaDB alternatifi: [`db/scylla/001_messages.cql`](../db/scylla/001_messages.cql)

## 1.6 Şemadaki Kritik Tasarım Kararları

**1. `seq` — kanal içi monotonik sıra numarası.**
Zaman damgası sıralama için yeterli değildir: sunucu saatleri kayar, aynı milisaniyede iki mesaj gelebilir. Her kanalda `BIGINT` bir sayaç tutulur (`channels.last_seq`, `UPDATE ... RETURNING` ile atomik artırılır). İstemci "seq 41'den 55'e atladım, arada kayıp var" tespitini bununla yapar ve yalnızca eksik aralığı ister. Bu, gerçek zamanlı sistemlerde tutarlılığın temelidir.

**2. Okundu bilgisi `last_read_seq` olarak — mesaj başına satır değil.**
200 kişilik bir kanalda 1.000 mesaj, mesaj-başına-okundu modelinde 200.000 satır demektir. Bunun yerine üye başına tek bir yüksek-su-seviyesi (`channel_members.last_read_seq`) tutulur: 200 satır. Okunmamış sayısı `last_seq - last_read_seq` ile O(1) hesaplanır. DM'lerde "kim okudu" zaten iki kişiden ibarettir; büyük kanallarda kişi-bazlı okundu bilgisi hem gereksiz hem gizlilik açısından tartışmalıdır.

**3. `messages` tablosu aylık RANGE partition.**
Retention politikası `DELETE` ile değil `DROP PARTITION` ile uygulanır — 50M satırlık bir silme işlemi yerine saniyeler süren metadata işlemi. VACUUM baskısı da ortadan kalkar.

**4. `audit_logs` append-only + hash zinciri.**
Her kayıt bir önceki kaydın hash'ini içerir (`prev_hash`). Bir denetim kaydının sonradan değiştirilmesi zinciri kırar ve tespit edilebilir hale gelir. Tabloda `UPDATE`/`DELETE` veritabanı seviyesinde tetikleyici (trigger) ile engellenir; uygulama kullanıcısına yalnızca `INSERT` ve `SELECT` yetkisi verilir.

**5. Ciphertext `BYTEA`, metadata `JSONB`.**
Şifreli gövde ikili olarak saklanır (base64 %33 yer israfıdır). Anahtar kimliği, IV ve şema sürümü ayrı sütunlardadır — anahtar rotasyonunda hangi satırın hangi DEK ile şifrelendiği bilinmelidir.

**6. Multi-tenant izolasyon: `org_id` + Row Level Security.**
Uygulama katmanındaki `WHERE org_id = ?` unutulabilir. PostgreSQL RLS politikası ile `current_setting('app.current_org')` zorunlu kılınır; bir kod hatası veri sızıntısına dönüşmez.
