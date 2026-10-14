# incompany yol haritası: v0.1.1 → v0.2

**v0.2'nin teması: "Gerçek hayatta güvenle çalışır."**
v0.1 kuralları (rıza, gizlilik) testlerle kanıtladı ama gerçek hesaplarla hiç çalışmadı. v0.2'ye kadar her adım küçük, tek başına yayınlanabilen bir yama sürümüdür. Her sürümün kendi "bitti sayılır" ölçütü var.

"Zihni" akıllandırmak (anlamsal arama, soru-cevap) bilerek v0.3'e bırakıldı: güvenmediğimiz bir hafızayı akıllandırmak yanlış sıra olur.

Boyutlar: **S** yarım gün, **M** 1–2 gün, **L** 3+ gün.

**Durum işaretleri:** ✅ kodlandı ve otomatik testlerle doğrulandı · 🟡 kod hazır, **gerçek hesap/altyapıyla doğrulama bekliyor**
(ayrıntı ve kontrol listeleri: [docs/dogrulama.md](docs/dogrulama.md)) · ☐ yapılmadı.

| Sürüm | Tema | Durum |
|---|---|---|
| v0.1.1 | Logo ve README | ✅ yayında |
| v0.1.2 | Doğrulama I: Telegram ve Slack | 🟡 eşleyici testleri ve CI hazır; canlı tur bekliyor |
| v0.1.3 | Doğrulama II: e-posta ve WhatsApp | 🟡 eşleyici testleri hazır; canlı tur ve "denenmedi" uyarısının kalkması bekliyor |
| v0.1.4 | Mesaj yaşam döngüsü: düzenleme ve silme | ✅ (Telegram silme: Bot API sınırı) · canlı tur 🟡 |
| v0.1.5 | Rıza I: gruba bildirim, kişi hariç tutma | ✅ · canlı bildirim turu 🟡 |
| v0.1.6 | Rıza II: saklama süresi, aydınlatma sürümü | ✅ |
| v0.1.7 | Kullanıcı ve ekip yönetimi | ✅ |
| v0.1.8 | KVKK veri talebi ve denetim kaydı | ✅ |
| v0.1.9 | Güvenlik sağlamlaştırma | ✅ (RLS sınırı: [guvenlik.md](docs/guvenlik.md)) · gerçek Postgres'te RLS 🟡 |
| v0.1.10 | İşletim: HTTPS, yedek, sağlık | 🟡 yazıldı; Docker/Postgres olmadan **çalıştırılıp denenmedi** |
| v0.1.11 | Panel cilası | ✅ |
| **v0.2** | Hukuki gözden geçirme ve yayın | ☐ (🟡 maddeler ve hukuk incelemesi şart) |

---

## v0.1.1 · Logo ve README ✅

Kilitli sohbet logosu (panel, favicon, README), yenilenmiş README. Yayında.

---

## v0.1.2 · Doğrulama I: Telegram ve Slack 🟡

Amaç: "çalışıyor gibi" yerine "çalıştığını gördük", ilk iki kaynakla.

- [ ] Telegram test botuyla bir gruptan mesaj al; panelde gör, ortak alanda ara. (S) — canlı
- [ ] Slack Socket Mode uygulaması; bir kanal ve bir DM'den mesaj. (S) — canlı
- [x] `telegramToIncoming` ve `slackToIncoming` için örnek mesajlarla birim testleri (metin, medya başlığı, düzenlenmiş, alt tipler). (M) — `test/mappers.test.ts`
- [x] GitHub Actions: tip kontrolü, testler, Docker build. (S) — `.github/workflows/ci.yml` (henüz bir GitHub koşusunda görülmedi)
- [x] Bulgular `docs/dogrulama.md` içinde başlar.

**Bitti sayılır:** iki kaynak için gerçek hesapla uçtan uca tur yapıldı, CI yeşil.

## v0.1.3 · Doğrulama II: e-posta ve WhatsApp 🟡

- [ ] Gerçek bir IMAP kutusu: yeniden başlatınca imleç kaldığı yerden devam ediyor mu, aynı e-posta çift yazılıyor mu, konu zinciri doğru toplanıyor mu. (M) — canlı
- [ ] WhatsApp test numarasıyla QR eşleştirme; DM `selected` akışı, grup `all`, geçmiş içe alma, telefondan bağlantıyı kaldırma. (M) — canlı
- [x] `whatsappToIncoming` ve `emailToIncoming` için birim testleri (anket, konum, kişi, belge, yanıtlı e-posta). (M)
- [ ] Bulunan hataların düzeltilmesi; bulgular `docs/dogrulama.md`'ye eklenir. (M) — canlı turdan sonra
- [ ] README'deki "denenmedi" uyarısı gerçek bulgularla güncellenir.

**Bitti sayılır:** dört kaynağın hepsi gerçek hesapla denendi, bulgular yazılı. WhatsApp için "resmî API'ye geçilsin mi" kararına yetecek veri var.

## v0.1.4 · Mesaj yaşam döngüsü: düzenleme ve silme ✅

Şu an düzenlenen mesaj yok sayılıyor, silinen mesaj hiç yakalanmıyor. Bu hem doğruluk hem gizlilik sorunu.

- [x] Telegram, Slack ve WhatsApp'ta düzenlenen mesajın içeriği güncellenir (önceki sürüm saklanmaz). (M)
- [x] Kaynakta silinen mesaj burada da silinir (Slack, WhatsApp). **Telegram:** Bot API silmeyi botlara bildirmez; yapılamaz. (M)
- [x] Bunlar için testler. (S) — `test/lifecycle.test.ts`, `test/mappers.test.ts`

**Bitti sayılır:** kaynakta düzenle/sil, birkaç saniye içinde panelde yansıyor. (Canlı doğrulama: dogrulama.md.)

## v0.1.5 · Rıza I: gruba bildirim ve kişi hariç tutma ✅

v0.1'in en büyük açığı: karşı tarafın haberi yok.

- [x] Bot gruba katılınca "bu grup şirket hafızasına kaydediliyor" mesajı (Telegram, Slack). Metin/kapatma hesap ayarında. (M)
- [x] WhatsApp için "kaydı gruba duyurmayı unutma" uyarısı rıza ekranında; rıza onayı aydınlatma metnini okumayı şart koşar. (S)
- [x] **Beni kaydetme listesi:** bir kişi ya da numara hiç kaydedilmez; ingest katmanında, her kaynakta. Panelden (Gizlilik ve KVKK) yönetilir; eklerken geçmişi de silinebilir. (M)

**Bitti sayılır:** hariç tutulan kişinin mesajı hiçbir kaynaktan kaydedilmiyor (testle kanıtlı: `test/privacy.test.ts`); botlu gruplarda bildirim görünüyor (canlı doğrulama bekliyor).

## v0.1.6 · Rıza II: saklama süresi ve aydınlatma sürümü ✅

- [x] Rıza kapsamına `retention_days`; süresi dolan mesajlar açılışta ve 6 saatte bir silinir; süre kısalınca hemen. Şirket botları için şirket süresi ayarı. (M)
- [x] Aydınlatma metninin sürümü `consent_log`'a yazılır; metin değişince yeniden onay istenir, onaylanana kadar toplama durur. (M)
- [x] Panelde rıza ekranına saklama süresi seçimi ve metin. (S)

**Bitti sayılır:** süresi dolan mesaj kendiliğinden siliniyor; metin sürümü değişince kaynaklar "rıza bekliyor"a dönüyor. (`test/retention.test.ts`)

## v0.1.7 · Kullanıcı ve ekip yönetimi ✅

- [x] Erişim anahtarı yenileme ve iptal; yönetici bir kullanıcının anahtarını sıfırlayabilir, herkes kendininkini yenileyebilir. (M)
- [x] **Ayrılan çalışan:** kullanıcıyı devre dışı bırak; kaynakları durur, sırları silinir, kişisel alanı silinir ya da seçilen kişiye devredilir; şirket botları yöneticiye geçer. (L)
- [x] **Ekip alanları:** panelde alan oluştur, üye ekle/çıkar. (M)

**Bitti sayılır:** bir çalışanın yaşam döngüsü (katıl → kullan → ayrıl) panelden yönetilebiliyor. (`test/users.test.ts`)

## v0.1.8 · KVKK veri talebi ve denetim kaydı ✅

- [x] Bir kişiye ait mesajları dışa aktar (JSON/CSV) ve talep üzerine sil (KVKK m.11). Dışa aktarma başkasının kişisel alanını açmaz; silme her yerde uygulanır. (M)
- [x] Yönetici denetim kaydı: kim hangi kullanıcıyı ekledi, bot kurdu, alan değiştirdi, veri talebi işledi. Panelde görünür. İçerik ve tam kimlik yazılmaz. (M)

**Bitti sayılır:** "bu kişinin verisini ver / sil" talebi panelden birkaç dakikada karşılanıyor ve kayıt altında.

## v0.1.9 · Güvenlik sağlamlaştırma ✅

- [x] `APP_SECRET` scrypt ile anahtara dönüyor; anahtar kimliği blobda; `APP_SECRET_PREVIOUS` + `rotate-secrets` ile rotasyon (eski kayıtlar okunabilir kalır). (M)
- [x] Giriş denemeleri için deneme kilidi; arama ve veri talepleri için hız sınırı. (S)
- [x] **Satır düzeyi güvenlik (RLS):** okuma yolları `incompany_reader` rolü ve kullanıcı kimliğiyle çalışır. **Sınır:** süper kullanıcı bağlantısında enjeksiyona karşı bariyer değil ([guvenlik.md](docs/guvenlik.md)). (L)

**Bitti sayılır:** anahtar rotasyonu denendi; başka birinin kişisel alanına erişim hem sorguda hem veritabanında engelli. (`test/security.test.ts` — gerçek Postgres'te RLS doğrulaması bekliyor)

## v0.1.10 · İşletim: HTTPS, yedek ve sağlık 🟡

- [x] `docker-compose` içinde Caddy ile otomatik HTTPS (`--profile https`). (S) — çalıştırılmadı
- [ ] Postgres yedeği, WhatsApp oturum klasörü ve geri yükleme adımları; **deneyerek** doğrula. (M) — betikler (`ops/`) yazıldı, Docker olmayan makinede denenemedi
- [x] `/health` bağlayıcı durumlarını da göstersin; Docker healthcheck; kopan bağlayıcıda panelde uyarı. (S)

**Bitti sayılır:** bir başkası belgeyle sistemi ayağa kaldırıp yedekten geri yükleyebiliyor.

## v0.1.11 · Panel cilası ✅

- [x] Konuşma listesi ve aramada sayfalama (konuşma listesi imleçle, arama ve mesajlar sayfa sayfa). (S)
- [x] Bağlayıcı durum ayrıntısı: hata mesajı, son başarılı eşitleme, "yeniden başlat" düğmesi. (S)
- [x] Konuşmada kişi bazlı bakış: kim ne kadar yazmış, son aktivite. (S)
- [x] Panelde "yönetici kişisel alanları göremez" kuralının açıkça gösterilmesi. (S)

**Bitti sayılır:** büyük bir hafızada panel akıcı (gerçek veriyle ölçülmedi); bağlayıcı sorunları kullanıcıya görünür.

---

## v0.2 · Hukuki gözden geçirme ve yayın

v0.2 etiketi yalnız şunlar doğruysa:

1. Dört kaynak gerçek hesapla doğrulandı (v0.1.2–v0.1.3). **← bekliyor**
2. Rıza yaşam döngüsü tam: bildirim, hariç tutma, saklama süresi, silme talebi, offboarding (v0.1.5–v0.1.8). **← kod tamam; canlı bildirim turu bekliyor**
3. Anahtar yönetimi, yedekleme ve CI hazır (v0.1.9–v0.1.10). **← anahtar yönetimi tamam; yedek geri yükleme denenmedi, CI henüz GitHub'da koşmadı**
4. Aydınlatma metni, çalışan taahhütnamesi şablonu ve veri sorumlusu bilgileri bir hukuk uzmanına gösterildi. (kod dışı) **← yapılmadı; varsayılan metin taslaktır**
5. README'deki "denenmedi" uyarıları kalktı, bilinen sınırlar güncel. **← sınırlar güncel; "denenmedi" uyarısı canlı turlardan sonra kalkar**

---

## Sonraya (v0.3 ve ötesi)

- **Anlamsal arama:** pgvector ile anlam tabanlı arama.
- **Sor:** hafızaya soru sor, kaynak mesajlarına bağlantılı cevap al (yalnız kullanıcının erişebildiği alanlardan).
- **Medya:** WhatsApp ses mesajları ve belgeler için yazıya çevirme / metin çıkarma.
- **Özetler:** günlük/haftalık ekip özeti, kararlar ve aksiyon maddeleri.
- **Resmî WhatsApp Business API** seçeneği (hesap kısıtlama riski olmadan, daha sınırlı kapsamla).
- **Dışa aktarma ve Obsidian/Notion köprüsü.**
- **RLS için ayrı, süper kullanıcı olmayan okuma bağlantısı** (enjeksiyona karşı gerçek bariyer).
- **Hız sınırını paylaşımlı hale getirmek** (birden çok uygulama kopyası için).

## Açık sorular (karar bekleyen)

- WhatsApp'ta resmî API'ye geçmek mi, `baileys` ile devam edip riski kabul etmek mi? (v0.1.3'ün canlı bulgularına göre.)
- ~~Ayrılan çalışanın kişisel alanı varsayılan olarak silinsin mi, devredilsin mi?~~ Panelde ikisi de seçenek; **varsayılan: sil** (devir açık bir seçimdir).
- Karşı tarafa bildirim konusunda şirketin hukuki görüşü ne? Botlar varsayılan olarak bildirim yazar; kapatmak hesap ayarıyla mümkün. (v0.2 hukuk incelemesi.)
- WhatsApp'ta kişisel kaynak sahibi, gruba bildirimi kendisi mi yapacak? (Kullanıcının hesabından otomatik mesaj yazmak bilinçli olarak yapılmadı.)
