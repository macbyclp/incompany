-- =============================================================================
--  iNCompany — ScyllaDB / Cassandra Mesaj Deposu
--
--  NE ZAMAN KULLANILIR?
--    PostgreSQL bölümlenmiş `messages` tablosu aylık 100M satırı geçtiğinde
--    VEYA kanal okuma p99 gecikmesi 150 ms'yi aştığında.
--    Bu eşiklere ulaşmadan bu şemayı devreye almak, transactional tutarlılığı
--    (seq atama + mesaj yazımı aynı transaction'da) kaybettirir ve karşılığında
--    ihtiyacınız olmayan bir ölçek verir.
--
--  Uygulama:
--    cqlsh -f 001_messages.cql
--
--  TASARIM İLKESİ
--    Cassandra'da şema, veriden değil SORGUDAN türetilir. Her tablo tek bir
--    erişim desenine hizmet eder; denormalizasyon bir kusur değil, yöntemdir.
-- =============================================================================

CREATE KEYSPACE IF NOT EXISTS incompany
WITH replication = {
    'class': 'NetworkTopologyStrategy',
    'dc1': 3          -- RF=3; QUORUM okuma/yazma ile tek düğüm kaybına dayanıklı
}
AND durable_writes = true;

USE incompany;

-- =============================================================================
--  SORGU 1: "Bir kanalın son N mesajını, yeniden eskiye doğru getir"  (%95 trafik)
--
--  Partition key: (channel_id, bucket)
--    Neden bucket? Yalnızca channel_id ile bölümlemek, yıllarca mesajlaşan bir
--    kanalda sınırsız büyüyen bir partition üretir. Cassandra'da partition
--    başına önerilen üst sınır ~100 MB / ~100K satırdır; aşıldığında okuma
--    gecikmesi ve compaction maliyeti patlar. `bucket` = YYYYMM formatında
--    aylık dilim: kanal ne kadar eskirse eskisin partition sabit boyutta kalır.
--
--  Clustering: seq DESC
--    Sunucu tarafından atanan monotonik sıra. Zaman damgası KULLANILMAZ:
--    düğüm saatleri kayar ve aynı milisaniyede iki mesaj çakışabilir.
--    DESC sıralama, en sık sorgunun (son mesajlar) diskte sıralı okunmasını sağlar.
-- =============================================================================

CREATE TABLE IF NOT EXISTS messages_by_channel (
    channel_id      uuid,
    bucket          int,            -- YYYYMM  (örn. 202608)
    seq             bigint,

    message_id      uuid,
    org_id          uuid,
    sender_id       uuid,
    kind            text,           -- TEXT | FILE | SYSTEM | CALL_EVENT

    -- ŞİFRELİ GÖVDE — düz metin bu tabloda ASLA bulunmaz
    ciphertext      blob,
    iv              blob,           -- 12 bayt GCM nonce
    auth_tag        blob,           -- 16 bayt GCM etiketi
    key_version     int,
    cipher_scheme   tinyint,

    -- Şifresiz metadata
    client_msg_id   uuid,
    reply_to_seq    bigint,
    thread_root_seq bigint,
    mentions        set<uuid>,
    has_attachment  boolean,
    attachment_ids  list<uuid>,
    dlp_verdict     text,           -- JSON

    created_at      timestamp,
    edited_at       timestamp,
    deleted_at      timestamp,

    PRIMARY KEY ((channel_id, bucket), seq)
)
WITH CLUSTERING ORDER BY (seq DESC)
  -- Zaman serisi verisi için doğru strateji. STCS, eski SSTable'ları
  -- gereksizce yeniden yazar; TWCS bunları oldukları gibi bırakır ve
  -- TTL dolduğunda tüm SSTable'ı tek seferde düşürür.
  AND compaction = {
      'class': 'TimeWindowCompactionStrategy',
      'compaction_window_unit': 'DAYS',
      'compaction_window_size': 7
  }
  AND compression = { 'sstable_compression': 'ZstdCompressor', 'chunk_length_in_kb': 16 }
  AND gc_grace_seconds = 86400          -- 1 gün (varsayılan 10 gün tombstone biriktirir)
  AND speculative_retry = '95percentile'
  AND comment = 'Kanal bazli mesaj gecmisi. Aylik bucket ile sinirli partition boyutu.';


-- =============================================================================
--  SORGU 2: "message_id ile tek mesaj getir"  (alıntı, kalıcı bağlantı, denetim)
--
--  Ana tablodan bu sorgu yapılamaz: message_id partition key'in parçası değildir.
--  Cassandra'da ikincil indeks yerine ARAMA TABLOSU (lookup table) kullanılır —
--  ikincil indeks tüm düğümlere yayılan bir sorgu (scatter-gather) üretir.
-- =============================================================================

CREATE TABLE IF NOT EXISTS message_lookup (
    message_id  uuid PRIMARY KEY,
    channel_id  uuid,
    bucket      int,
    seq         bigint,
    org_id      uuid
)
WITH compaction = { 'class': 'LeveledCompactionStrategy' }
  AND comment = 'message_id -> (channel_id, bucket, seq) esleme. Nokta okuma icin.';


-- =============================================================================
--  SORGU 3: "Kullanıcının bir kanaldaki okuma durumu"
--
--  Yüksek-su-seviyesi modeli: mesaj başına okundu satırı TUTULMAZ.
--  200 üyeli, 1000 mesajlı bir kanal → 200 satır (200.000 değil).
-- =============================================================================

CREATE TABLE IF NOT EXISTS read_state_by_user (
    user_id             uuid,
    channel_id          uuid,
    last_read_seq       bigint,
    last_delivered_seq  bigint,
    updated_at          timestamp,

    PRIMARY KEY (user_id, channel_id)
)
WITH compaction = { 'class': 'LeveledCompactionStrategy' }   -- okuma ağırlıklı + sık güncellenen
  AND comment = 'Kullanici basina kanal okuma imleci.';


-- =============================================================================
--  SORGU 4: "Bir kanaldaki en son mesajı kim okudu?"  (DM okundu bilgisi)
--  Ters yön arama — DM ve küçük gruplarda kullanılır.
-- =============================================================================

CREATE TABLE IF NOT EXISTS read_state_by_channel (
    channel_id      uuid,
    user_id         uuid,
    last_read_seq   bigint,
    updated_at      timestamp,

    PRIMARY KEY (channel_id, user_id)
)
WITH compaction = { 'class': 'LeveledCompactionStrategy' }
  AND comment = 'Kanal basina uye okuma imleci. DM okundu gostergesi icin.';


-- =============================================================================
--  SORGU 5: "Bir konu başlığındaki (thread) yanıtlar"
-- =============================================================================

CREATE TABLE IF NOT EXISTS thread_replies (
    channel_id      uuid,
    thread_root_seq bigint,
    seq             bigint,
    message_id      uuid,
    sender_id       uuid,
    created_at      timestamp,

    PRIMARY KEY ((channel_id, thread_root_seq), seq)
)
WITH CLUSTERING ORDER BY (seq ASC)     -- konu başlığı kronolojik okunur
  AND compaction = { 'class': 'LeveledCompactionStrategy' }
  AND comment = 'Konu basligi yanitlari. Ana tablodan ayri: farkli siralama yonu.';


-- =============================================================================
--  SORGU 6: "Kullanıcıya yapılan bahsetmeler (mentions)"
-- =============================================================================

CREATE TABLE IF NOT EXISTS mentions_by_user (
    user_id     uuid,
    bucket      int,
    created_at  timestamp,
    message_id  uuid,
    channel_id  uuid,
    seq         bigint,
    sender_id   uuid,
    is_read     boolean,

    PRIMARY KEY ((user_id, bucket), created_at, message_id)
)
WITH CLUSTERING ORDER BY (created_at DESC, message_id ASC)
  AND compaction = {
      'class': 'TimeWindowCompactionStrategy',
      'compaction_window_unit': 'DAYS',
      'compaction_window_size': 7
  }
  AND default_time_to_live = 7776000     -- 90 gün; bahsetme bildirimi kalıcı veri değil
  AND comment = 'Bahsetme gelen kutusu. TTL ile otomatik temizlenir.';


-- =============================================================================
--  İŞLETİM NOTLARI — Cassandra'ya özgü tuzaklar
--
--  1) TUTARLILIK SEVİYESİ
--     Yazma: LOCAL_QUORUM   Okuma: LOCAL_QUORUM
--     RF=3'te 2+2 > 3 olduğu için okuma-sonrası-yazma tutarlılığı sağlanır.
--     ONE kullanmayın: kullanıcı kendi gönderdiği mesajı görememeye başlar.
--
--  2) SIRA NUMARASI ATAMA
--     Cassandra'da atomik sayaç YOKTUR (counter sütunları idempotent değildir
--     ve okunup yazılamaz). `seq` üretimi Cassandra'ya BIRAKILMAZ:
--       · Tercih edilen: PostgreSQL `next_channel_seq()` (bkz. 001_schema.sql)
--       · Alternatif: Redis INCR (kalıcılık AOF everysec ile)
--     LWT (IF NOT EXISTS / Paxos) kullanmayın — 4 tur yol gidiş-dönüş,
--     ~10x gecikme ve mesaj gönderimi sıcak yolda bunu kaldırmaz.
--
--  3) SİLME VE MEZAR TAŞLARI (tombstones)
--     Toplu DELETE, okuma performansını yok eden tombstone birikimi yaratır.
--     Retention için DELETE değil TTL kullanın:
--       INSERT INTO messages_by_channel (...) VALUES (...) USING TTL 31536000;
--     TWCS ile birlikte, süresi dolan tüm SSTable tek işlemde düşürülür.
--
--  4) BUCKET HESAPLAMA (uygulama tarafı — tek kaynak)
--       const bucket = date.getUTCFullYear() * 100 + (date.getUTCMonth() + 1);
--     Sayfalama sırasında bir bucket tükendiğinde istemci bir önceki aya iner.
--     Boş ayları taramamak için kanalın ilk mesaj bucket'ı metadata'da tutulur.
--
--  5) İDEMPOTENCY
--     Cassandra'da UPSERT semantiği vardır: aynı (partition, clustering) ile
--     yapılan ikinci yazım sessizce üzerine yazar. Bu, ağ yeniden denemelerinde
--     avantajdır — ancak yalnızca `seq` zaten atanmışsa. Dolayısıyla
--     idempotency kontrolü seq atamasından ÖNCE yapılmalıdır (Redis SET NX).
-- =============================================================================
