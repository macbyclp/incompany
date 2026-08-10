# Adım 2 — Gerçek Zamanlı Mesajlaşma Mimarisi

## 2.1 Event Sözleşmesi (Contract)

Tüm event'ler tek bir TypeScript dosyasında tanımlanır ve backend ile frontend bu dosyayı **paylaşır** (`packages/contracts`). Böylece bir event'in şekli değiştiğinde her iki taraf da derleme zamanında kırılır — çalışma zamanında değil.

### İsimlendirme kuralı

```
<domain>:<action>
```

Yön (client→server / server→client) isimden değil, **tip tanımından** anlaşılır: `ClientToServerEvents` ve `ServerToClientEvents`.

### İstemci → Sunucu

| Event | Payload | Ack | Açıklama |
|---|---|---|---|
| `message:send` | `{ channelId, clientMsgId, body, replyToSeq?, attachmentIds? }` | `{ ok, messageId, seq, serverTs }` | **Ack zorunlu.** İstemci ack gelene kadar mesajı "gönderiliyor" durumunda tutar. |
| `message:edit` | `{ channelId, seq, body }` | `{ ok, editedAt }` | |
| `message:delete` | `{ channelId, seq }` | `{ ok }` | Mantıksal silme |
| `message:read` | `{ channelId, upToSeq }` | `{ ok, unread }` | Yüksek-su-seviyesi güncellemesi |
| `channel:subscribe` | `{ channelIds }` | `{ ok, joined, denied }` | Tembel (lazy) oda katılımı |
| `channel:unsubscribe` | `{ channelIds }` | `{ ok }` | |
| `channel:sync` | `{ channelId, sinceSeq }` | `{ ok, messages, hasMore }` | **Yeniden bağlanma boşluk doldurma** |
| `typing:start` | `{ channelId }` | — | Ateşle-unut, sunucuda 4 sn kısıtlı |
| `typing:stop` | `{ channelId }` | — | |
| `presence:set` | `{ status, customText?, until? }` | `{ ok }` | Manuel durum |
| `heartbeat` | `{ ts }` | `{ serverTs }` | 25 sn'de bir; presence TTL'ini tazeler |

### Sunucu → İstemci

| Event | Payload | Açıklama |
|---|---|---|
| `message:new` | `MessageDto` | Kanal odasına yayın |
| `message:updated` | `{ channelId, seq, body, editedAt }` | |
| `message:deleted` | `{ channelId, seq, deletedAt, deletedBy }` | |
| `message:receipt` | `{ channelId, userId, lastReadSeq }` | Okundu bilgisi |
| `message:blocked` | `{ clientMsgId, reason, ruleKeys }` | **DLP engelledi** — yalnızca gönderene |
| `typing:update` | `{ channelId, userIds }` | Toplu (debounced) yazıyor listesi |
| `presence:update` | `{ userId, status, customText? }` | |
| `channel:created` / `channel:updated` / `channel:member_added` / `channel:member_removed` | | |
| `session:revoked` | `{ reason }` | Rol değişimi / oturum sonlandırma → istemci çıkış yapar |
| `error` | `{ code, message, correlationId }` | Standart hata zarfı |

### Ack neden zorunlu?

WebSocket "gönderdim" ile "sunucu kalıcı olarak yazdı"yı ayırt etmez. Ack olmadan istemci, sunucu diske yazmadan önce çökerse mesajın kaybolduğunu asla öğrenemez. Socket.IO ack callback'i bu boşluğu kapatır:

```
İstemci                          Sunucu
   │  emit('message:send', p, cb)   │
   ├───────────────────────────────▶│  DLP → şifrele → PERSIST
   │                                 │  (seq atandı, dayanıklı)
   │  cb({ ok:true, seq:42 })        │
   │◀───────────────────────────────┤
   │  optimistic → confirmed         │
```

İstemci 10 sn içinde ack alamazsa mesajı `failed` işaretler ve yeniden dener — **aynı `clientMsgId` ile**. İdempotency katmanı çift kaydı engeller.

## 2.2 Yatay Ölçekleme (Horizontal Scaling)

### Temel problem

```
   Kullanıcı A ──▶ Gateway-1        Gateway-2 ◀── Kullanıcı B
                      │                 │
                      └── A'nın mesajı B'ye nasıl ulaşacak? ──┘
```

WebSocket bağlantıları **durumludur (stateful)**. Gateway-1'deki bir socket, Gateway-2'deki bir socket'e doğrudan yazamaz. Çözüm: düğümler arası bir yayın (fanout) katmanı.

### Çözüm: Redis Streams Adapter + Sticky Session YOK

```
                    ┌──────────────────────────────────────┐
                    │  L7 Load Balancer (sticky session ✗) │
                    └───────┬──────────┬──────────┬────────┘
                            │          │          │
                  ┌─────────▼──┐ ┌─────▼──────┐ ┌─▼──────────┐
                  │ Gateway-1  │ │ Gateway-2  │ │ Gateway-3  │
                  │ ~8K socket │ │ ~8K socket │ │ ~8K socket │
                  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
                        │              │              │
                        └──────────────┼──────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │        Redis Cluster          │
                        │                               │
                        │ Stream: socket.io#/#          │  ← oda yayını
                        │ Hash:   presence:{userId}     │  ← TTL 45 sn
                        │ Set:    sockets:{userId}      │  ← çoklu cihaz
                        │ Set:    typing:{channelId}    │  ← TTL 5 sn
                        │ String: ratelimit:{userId}    │
                        │ String: idem:{clientMsgId}    │  ← TTL 5 dk
                        └───────────────────────────────┘
```

**Sticky session neden istenmez?** Sticky session, bir gateway'in düşmesi durumunda o düğümdeki tüm kullanıcıların yeniden kimlik doğrulaması gerektirmesine ve LB'nin yeniden dengeleme yapamamasına yol açar. Adapter modeliyle her socket herhangi bir düğüme bağlanabilir; oda üyeliği Redis üzerinden paylaşılır.

**Pub/Sub değil Streams neden?** Klasik Redis Pub/Sub *ateşle-unut*'tur: bir gateway 200 ms ağ kesintisi yaşarsa o aralıktaki mesajları **kalıcı olarak** kaçırır. `@socket.io/redis-streams-adapter` ise `XADD`/`XREAD` kullanır; düğüm bağlantısı kopup döndüğünde son okunan ID'den devam eder ve boşluk oluşmaz.

```typescript
// main.ts — adapter kurulumu
import { createAdapter } from '@socket.io/redis-streams-adapter';

const io = app.get(ChatGateway).server;
io.adapter(createAdapter(redisClient, {
  streamName: 'incompany:socketio',
  maxLen: 10_000,          // stream'i sınırla, bellek patlamasın
  readCount: 100,
}));
```

### Oda (room) stratejisi

| Oda | Ne zaman katılınır | Amaç |
|---|---|---|
| `u:{userId}` | Bağlantı anında, her zaman | Kullanıcının tüm cihazlarına yayın (`session:revoked`, DM bildirimi) |
| `c:{channelId}` | **Tembel** — kullanıcı kanalı açtığında | Mesaj yayını |
| `o:{orgId}` | Bağlantı anında | Organizasyon geneli duyuru |

**Tembel katılım neden kritik?** 200 kanala üye bir kullanıcı, bağlantı anında 200 odaya katılırsa Redis'te 200 kayıt ve her mesajda gereksiz fanout oluşur. 10.000 kullanıcı × 200 kanal = 2M oda üyeliği. Gerçekte kullanıcı aynı anda 1–3 kanala bakar. Arka plandaki kanallar için yalnızca *okunmamış sayacı* güncellenir — bu, `u:{userId}` odasına gönderilen hafif bir `channel:badge` event'i ile yapılır ve mesaj gövdesi taşımaz.

### Presence: TTL tabanlı, kalp atışıyla tazelenen

```
  İstemci ──heartbeat (25 sn)──▶ Gateway ──▶ Redis
                                              SETEX presence:{userId} 45 "ONLINE"

  TTL doldu (45 sn kalp atışı yok)
       └──▶ keyspace notification ──▶ Gateway ──▶ broadcast presence:update OFFLINE
```

`disconnect` olayına **güvenilmez**: dizüstü kapağı kapandığında, mobil ağ değiştiğinde veya süreç `SIGKILL` aldığında disconnect event'i hiç gelmez. TTL modeli bu durumların hepsini otomatik olarak kapsar. 45 sn TTL / 25 sn kalp atışı oranı, tek bir paket kaybının kullanıcıyı yanlışlıkla çevrimdışı göstermemesini sağlar.

**Çoklu cihaz:** `sockets:{userId}` bir Redis SET'idir. Kullanıcı ancak set boşaldığında çevrimdışı olur. Telefon + masaüstü açıkken masaüstü kapanırsa kullanıcı çevrimiçi kalır.

### Yazıyor göstergesi (typing): asla kalıcı değil

```typescript
// typing:start  →  SADD typing:{channelId} {userId} + EXPIRE 5
// Yayın 1 sn'de bir toplu (batched) yapılır — her tuş vuruşunda DEĞİL.
```

50 kişilik bir kanalda herkes yazarken, tuş başına yayın saniyede binlerce event üretir. Bunun yerine gateway 1 sn'lik pencerelerde Redis SET'in tamamını okur ve tek bir `typing:update` event'i yayınlar. Veritabanına hiçbir şey yazılmaz.

## 2.3 Yeniden Bağlanma ve Boşluk Doldurma (Gap Recovery)

Bu, gerçek zamanlı sistemlerin en sık atlanan parçasıdır. Bağlantı koptuğunda kaçırılan mesajlar **yeniden yayınlanmaz** — istemci bunları aktif olarak istemelidir.

```
 İstemci                                    Sunucu
   │ [bağlantı koptu — 30 sn]                  │
   │                                            │
   │ reconnect + auth                           │
   ├───────────────────────────────────────────▶│
   │ channel:sync { channelId, sinceSeq: 41 }   │
   ├───────────────────────────────────────────▶│
   │                                            │ SELECT ... WHERE seq > 41
   │ ack { messages: [42..58], hasMore: false } │       ORDER BY seq LIMIT 200
   │◀───────────────────────────────────────────┤
   │ store'a birleştir, seq'e göre sırala        │
```

İstemci tarafında sürekli çalışan boşluk denetimi:

```typescript
// Gelen her mesajda: seq beklenenden büyükse arada kayıp var
if (incoming.seq > lastKnownSeq + 1) {
  socket.emit('channel:sync', { channelId, sinceSeq: lastKnownSeq });
}
```

`hasMore: true` dönerse istemci son alınan seq ile tekrar ister. 200 mesajlık sayfa sınırı, uzun süre çevrimdışı kalmış bir istemcinin sunucuyu kilitlemesini engeller.

## 2.4 Backpressure ve Kaynak Koruması

| Katman | Sınır | Aşılırsa |
|---|---|---|
| Bağlantı / IP | 20 eşzamanlı | Yeni bağlantı reddedilir |
| Bağlantı / kullanıcı | 8 cihaz | En eski socket kapatılır |
| `message:send` | 20 / 10 sn (kayan pencere) | `error` + 429, socket açık kalır |
| `channel:subscribe` | 50 kanal / socket | Fazlası `denied` listesinde döner |
| Mesaj gövdesi | 64 KB (şifrelenmiş) | Reddedilir |
| Socket yazma tamponu | 1 MB | Socket kapatılır (yavaş tüketici koruması) |
| Kimlik doğrulanmamış socket | 10 sn | Otomatik kapatılır |

**Kritik nokta:** Rate limit aşımında socket **kapatılmaz**, yalnızca hata döner. Socket kapatmak istemcinin agresif yeniden bağlanma döngüsüne girmesine yol açar ve sorunu ağırlaştırır.

## 2.5 Ne Zaman Kafka?

Redis Streams, socket düğümleri arası fanout için doğru araçtır. Kafka **farklı bir problemi** çözer: dayanıklı, yeniden oynatılabilir (replayable), çok tüketicili olay logu.

| İhtiyaç | Araç |
|---|---|
| Gateway → Gateway mesaj yayını | **Redis Streams** (mikrosaniye gecikme) |
| Arama indeksleme (OpenSearch) | **Kafka** — indeksleyici saatlerce düşse de olayları kaçırmaz |
| Denetim kaydı → SIEM | **Kafka** — uyum gereği yeniden oynatılabilir olmalı |
| Analitik / veri ambarı | **Kafka** |
| Bildirim (push/e-posta) | **Kafka** — yeniden deneme ve ölü mektup kuyruğu (DLQ) gerekir |

Bunların hepsi **transactional outbox** üzerinden beslenir: mesaj ve olay aynı PostgreSQL transaction'ında yazılır, ayrı bir relay süreci (veya Debezium CDC) Kafka'ya taşır. Böylece "DB'ye yazdım ama Kafka'ya yazamadım" tutarsızlığı yapısal olarak imkânsız hale gelir.

## 2.6 Kapasite Tahmini

10.000 çalışanlık bir kurum, %30 eşzamanlı = 3.000 aktif socket:

| Kaynak | Hesap | Sonuç |
|---|---|---|
| Gateway düğümü | ~8.000 socket / 2 vCPU · 4 GB | **1 düğüm yeterli, 3 çalıştırın** (HA + rolling deploy) |
| Socket başına bellek | ~40 KB (Node + Socket.IO) | 3.000 × 40 KB ≈ 120 MB |
| Zirve mesaj hızı | 3.000 × 4 msg/sa ÷ 3600 × 10 (zirve) | ~33 msg/sn |
| Fanout | 33 msg/sn × ort. 12 alıcı | ~400 event/sn |
| Redis işlem hacmi | fanout + presence + typing | ~2.000 ops/sn (tek düğüm 100K+ kaldırır) |
| PostgreSQL yazma | 33 INSERT/sn + seq UPDATE | Önemsiz |

**Sonuç:** Bu ölçek tek bir orta boy sunucuda çalışır. Üç replika, performans için değil **kullanılabilirlik** içindir. Mimarinin ölçeklenebilir olması, gün-1'de ölçeklenmiş olmasını gerektirmez.
