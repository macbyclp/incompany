# Güvenlik modeli

Bu belge neyin korunduğunu, nasıl korunduğunu ve **nelerin korunmadığını** anlatır.

## Erişim kuralları

- Her kullanıcının tek bir **kişisel alanı** vardır. Birebir yazışmalar ve e-postalar buraya düşer. **Yönetici dahil kimse**
  başkasının kişisel alanını listeleyemez, arayamaz, okuyamaz, dışa aktaramaz.
- **Ortak alan** (şirket) ve **ekip alanları**: yalnız üyeler görür. Bir konuşma bu alanlara yalnız sahibinin kararıyla taşınır.
- Yönetici; kullanıcı ekler, anahtar yeniler, çalışanı ayrıldı işaretler, şirket botlarını kurar, "beni kaydetme" listesini
  ve KVKK taleplerini yönetir. **Bu yetkilerin hiçbiri kişisel alana erişim vermez.** Çalışan ayrılırken kişisel alan,
  yöneticinin seçtiği bir kişiye *devredilebilir*; bu açık ve denetim kaydına yazılan bir karardır.

Kural üç yerde uygulanır: (1) sorgudaki erişim filtresi, (2) veritabanı satır düzeyi güvenliği, (3) API testleri
(`test/api.test.ts` — "yönetici kişisel alanı göremez").

## Satır düzeyi güvenlik (RLS)

Okuma yolları (arama, konuşma listesi, mesajlar, genel bakış) salt okunur bir işlemde `incompany_reader` rolüyle ve
`app.user_id` = isteği yapan kullanıcı olarak çalışır. `messages`, `conversations`, `spaces` tablolarında politika vardır:
bir kullanıcı yalnız üyesi olduğu alanların (ya da kendi hesaplarının) satırlarını görür. Rol, `accounts.secrets` ve
`users.token_hash` sütunlarını **hiç okuyamaz**; yazamaz.

**Sınır — bunu bil:** uygulama veritabanına süper kullanıcı (Docker'daki `postgres`) olarak bağlanır ve rol `SET LOCAL ROLE`
ile alınır. Süper kullanıcı oturumu `SET ROLE` ile rolden çıkabilir; yani RLS, **sorgu hatalarına karşı savunma
derinliğidir (bir WHERE unutulursa veritabanı yine de sızdırmaz), SQL enjeksiyonuna karşı bir bariyer değildir.**
Tüm sorgular parametreli olduğundan enjeksiyon yüzeyi bilinen bir yerde yok; yine de ileride kullanılacak daha sıkı
düzen: uygulamayı süper kullanıcı olmayan bir `LOGIN` rolüyle bağlayıp okuma yolu için ayrı bir bağlantı havuzu açmak.
Bu yapılmadı ve doğrulanmadı.

Yazma yolları (içe alma, rıza, yönetim) tablo sahibi olarak çalışır; RLS'e tabi değildir.

## Sırlar

- Bot anahtarları, IMAP parolaları vb. `accounts.secrets` içinde **AES-256-GCM** ile saklanır.
- Anahtar `APP_SECRET`'tan **scrypt** ile türetilir (`v2` biçimi, anahtar kimliği blobda). Eski (v0.1) tek SHA-256
  biçimi okunmaya devam eder ve `rotate-secrets` ile yükseltilir.
- **Anahtar rotasyonu:** `APP_SECRET` + `APP_SECRET_PREVIOUS` + `rotate-secrets` ([isletim.md](isletim.md#5-anahtar-rotasyonu-app_secret)).
  Rotasyon `test/security.test.ts` içinde denenmiştir: eski anahtarla şifreli kayıt rotasyondan sonra eski anahtar
  olmadan okunur; okunamayan bir kayıt varsa hiçbir kayıt değişmez.
- Erişim anahtarları (kullanıcı token'ları) veritabanında yalnız SHA-256 özeti olarak durur; düz hali bir kez gösterilir.
  Yeniden üretilebilir, iptal edilebilir; ayrılan çalışanınki otomatik silinir.
- WhatsApp oturum anahtarları dosya olarak `DATA_DIR` altındadır, **şifrelenmez**; diske erişen oturumu kullanabilir.
  Rıza geri çekilince ve çalışan ayrılınca silinir.

## Hız sınırı ve kilit

Bellek içi, süreç başına (tek süreçli dağıtım için). Birden çok kopya çalıştırırsan sayaçlar paylaşılmaz.

| Koruma | Değer |
|---|---|
| Geçersiz erişim anahtarı denemesi | 15 dakikada 10 → IP 15 dakika kilitlenir (kilitliyken geçerli anahtar da reddedilir, `Retry-After`) |
| Arama | Kullanıcı başına dakikada 60 |
| Veri talebi (dışa aktarma/silme) | Kullanıcı başına dakikada 20 |

Yalnız **sunulup reddedilen** anahtarlar denemeye sayılır; anahtarsız istekler (favicon, tarayıcı yoklaması) sayılmaz.
Ters vekil arkasında `TRUST_PROXY=1` şarttır, yoksa herkes tek IP görünür.

## Denetim

Yönetici işlemleri `audit_log` tablosunda silinmeden tutulur: kullanıcı/anahtar/alan/hariç tutma/ayar değişiklikleri,
veri talepleri, çalışan ayrılışı, saklama süresi temizliği, anahtar rotasyonu. **İçerik ve tam kimlik yazılmaz** (veri
talebinde kişi yalnız bir özet değeriyle anılır). Rıza işlemleri ayrıca `consent_log`'dadır (kişinin kendi ekranında).

## Bilinen sınırlar

- Telegram Bot API, silinen mesajı botlara bildirmez: Telegram'da silinen mesaj burada kalır (düzenleme yansır).
- Slack ve WhatsApp'ta düzenleme/silme olayları işlenir (örnek olaylarla test edildi; canlı doğrulama bekliyor, bkz.
  [dogrulama.md](dogrulama.md)); e-posta için yaşam döngüsü izlenmez.
- WhatsApp'ta gizlenmiş (`@lid`) kimlikler telefon numarasıyla eşleşmeyebilir; "beni kaydetme" listesine LID'i de ekle.
- İçe aktarılan mesajın `raw` alanı kaynaktan gelen ham veriyi tutar; saklama süresi ve silme bunu da kapsar (satırla birlikte silinir).
- Arama dizini (`tsvector`) ve veritabanı yedekleri silinen mesajı yedekten geri getirebilir; silme talebi sonrası eski yedeklerin
  ömrü bu yüzden sınırlı tutulmalıdır.
