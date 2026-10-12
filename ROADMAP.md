# incompany yol haritası: v0.1.1 → v0.2

**v0.2'nin teması: "Gerçek hayatta güvenle çalışır."**
v0.1 kuralları (rıza, gizlilik) testlerle kanıtladı ama gerçek hesaplarla hiç çalışmadı. v0.2'ye kadar her adım küçük, tek başına yayınlanabilen bir yama sürümüdür. Her sürümün kendi "bitti sayılır" ölçütü var.

"Zihni" akıllandırmak (anlamsal arama, soru-cevap) bilerek v0.3'e bırakıldı: güvenmediğimiz bir hafızayı akıllandırmak yanlış sıra olur.

Boyutlar: **S** yarım gün, **M** 1–2 gün, **L** 3+ gün.

| Sürüm | Tema | Durum |
|---|---|---|
| v0.1.1 | Logo ve README | ✅ yayında |
| v0.1.2 | Doğrulama I: Telegram ve Slack | ☐ |
| v0.1.3 | Doğrulama II: e-posta ve WhatsApp | ☐ |
| v0.1.4 | Mesaj yaşam döngüsü: düzenleme ve silme | ☐ |
| v0.1.5 | Rıza I: gruba bildirim, kişi hariç tutma | ☐ |
| v0.1.6 | Rıza II: saklama süresi, aydınlatma sürümü | ☐ |
| v0.1.7 | Kullanıcı ve ekip yönetimi | ☐ |
| v0.1.8 | KVKK veri talebi ve denetim kaydı | ☐ |
| v0.1.9 | Güvenlik sağlamlaştırma | ☐ |
| v0.1.10 | İşletim: HTTPS, yedek, sağlık | ☐ |
| v0.1.11 | Panel cilası | ☐ |
| **v0.2** | Hukuki gözden geçirme ve yayın | ☐ |

---

## v0.1.1 · Logo ve README ✅

Kilitli sohbet logosu (panel, favicon, README), yenilenmiş README. Yayında.

---

## v0.1.2 · Doğrulama I: Telegram ve Slack

Amaç: "çalışıyor gibi" yerine "çalıştığını gördük", ilk iki kaynakla.

- [ ] Telegram test botuyla bir gruptan mesaj al; panelde gör, ortak alanda ara. (S)
- [ ] Slack Socket Mode uygulaması; bir kanal ve bir DM'den mesaj. (S)
- [ ] `telegramToIncoming` ve `slackToIncoming` için gerçek örnek mesajlarla birim testleri (metin, medya başlığı, düzenlenmiş, alt tipler). (M)
- [ ] GitHub Actions: tip kontrolü, testler, Docker build. (S)
- [ ] Bulgular `docs/dogrulama.md` içinde başlar.

**Bitti sayılır:** iki kaynak için gerçek hesapla uçtan uca tur yapıldı, CI yeşil.

## v0.1.3 · Doğrulama II: e-posta ve WhatsApp

- [ ] Gerçek bir IMAP kutusu: yeniden başlatınca imleç kaldığı yerden devam ediyor mu, aynı e-posta çift yazılıyor mu, konu zinciri doğru toplanıyor mu. (M)
- [ ] WhatsApp test numarasıyla QR eşleştirme; DM `selected` akışı, grup `all`, geçmiş içe alma, telefondan bağlantıyı kaldırma. (M)
- [ ] `whatsappToIncoming` ve `emailToIncoming` için birim testleri (anket, konum, kişi, belge, yanıtlı e-posta). (M)
- [ ] Bulunan hataların düzeltilmesi; bulgular `docs/dogrulama.md`'ye eklenir. (M)
- [ ] README'deki "denenmedi" uyarısı gerçek bulgularla güncellenir.

**Bitti sayılır:** dört kaynağın hepsi gerçek hesapla denendi, bulgular yazılı. WhatsApp için "resmî API'ye geçilsin mi" kararına yetecek veri var.

## v0.1.4 · Mesaj yaşam döngüsü: düzenleme ve silme

Şu an düzenlenen mesaj yok sayılıyor, silinen mesaj hiç yakalanmıyor. Bu hem doğruluk hem gizlilik sorunu.

- [ ] Telegram, Slack ve WhatsApp'ta düzenlenen mesajın içeriği güncellenir (önceki sürüm saklanmaz). (M)
- [ ] Kaynakta silinen mesaj burada da silinir. (M)
- [ ] Bunlar için testler. (S)

**Bitti sayılır:** kaynakta düzenle/sil, birkaç saniye içinde panelde yansıyor.

## v0.1.5 · Rıza I: gruba bildirim ve kişi hariç tutma

v0.1'in en büyük açığı: karşı tarafın haberi yok.

- [ ] Bot gruba katılınca "bu grup şirket hafızasına kaydediliyor" mesajı (Telegram, Slack). (M)
- [ ] WhatsApp için sahibine "grupta bunu duyurmayı unutma" uyarısı rıza ekranında. (S)
- [ ] **Beni kaydetme listesi:** bir kişi ya da numara hiç kaydedilmez; ingest katmanında, her kaynakta. Panelden yönetilir. (M)

**Bitti sayılır:** hariç tutulan kişinin mesajı hiçbir kaynaktan kaydedilmiyor (testle kanıtlı); botlu gruplarda bildirim görünüyor.

## v0.1.6 · Rıza II: saklama süresi ve aydınlatma sürümü

- [ ] Rıza kapsamına `retention_days`; süresi dolan mesajlar günlük bir işle silinir. (M)
- [ ] Aydınlatma metninin sürümü `consent_log`'a yazılır; metin değişince yeniden onay istenir, onaylanana kadar toplama durur. (M)
- [ ] Panelde rıza ekranına saklama süresi seçimi. (S)

**Bitti sayılır:** süresi dolan mesaj kendiliğinden siliniyor; metin sürümü değişince kaynaklar "rıza bekliyor"a dönüyor.

## v0.1.7 · Kullanıcı ve ekip yönetimi

Şu an kullanıcı silmenin, anahtarı yenilemenin ve ekip alanı oluşturmanın yolu yok.

- [ ] Erişim anahtarı yenileme ve iptal; yönetici bir kullanıcının anahtarını sıfırlayabilir. (M)
- [ ] **Ayrılan çalışan:** kullanıcıyı devre dışı bırak; kaynakları durur, kişisel alanı silinir ya da seçilen kişiye devredilir. (L)
- [ ] **Ekip alanları:** panelde alan oluştur, üye ekle/çıkar (`team` türü şemada var, yolu yok). (M)

**Bitti sayılır:** bir çalışanın yaşam döngüsü (katıl → kullan → ayrıl) panelden yönetilebiliyor.

## v0.1.8 · KVKK veri talebi ve denetim kaydı

- [ ] Bir kişiye ait mesajları dışa aktar (JSON/CSV) ve talep üzerine sil (KVKK m.11). (M)
- [ ] Yönetici denetim kaydı: kim hangi kullanıcıyı ekledi, bot kurdu, alan değiştirdi, veri talebi işledi. Panelde görünür. (M)

**Bitti sayılır:** "bu kişinin verisini ver / sil" talebi panelden birkaç dakikada karşılanıyor ve kayıt altında.

## v0.1.9 · Güvenlik sağlamlaştırma

- [ ] `APP_SECRET` şu an tek SHA-256 ile anahtara dönüyor. HKDF/scrypt ve anahtar rotasyonu (eski anahtarla şifrelenmiş kayıtlar okunabilir kalır). (M)
- [ ] Giriş denemeleri ve arama için hız sınırı; deneme kilidi. (S)
- [ ] **Satır düzeyi güvenlik (RLS):** alan erişimini sorgunun yanında veritabanı düzeyinde de zorla; savunma derinliği. (L)

**Bitti sayılır:** anahtar rotasyonu denendi; başka birinin kişisel alanına erişim hem sorguda hem veritabanında engelli.

## v0.1.10 · İşletim: HTTPS, yedek ve sağlık

- [ ] `docker-compose` içinde Caddy ile otomatik HTTPS örneği. (S)
- [ ] Postgres yedeği, WhatsApp oturum klasörü ve geri yükleme adımları; **deneyerek** doğrula. (M)
- [ ] `/health` bağlayıcı durumlarını da göstersin; Docker healthcheck; kopan bağlayıcıda panelde uyarı. (S)

**Bitti sayılır:** bir başkası belgeyle sistemi ayağa kaldırıp yedekten geri yükleyebiliyor.

## v0.1.11 · Panel cilası

- [ ] Konuşma listesi ve aramada sayfalama (şu an 500 ile sınırlı). (S)
- [ ] Bağlayıcı durum ayrıntısı: hata mesajı, son başarılı eşitleme, "yeniden başlat" düğmesi. (S)
- [ ] Konuşmada kişi bazlı bakış: kim ne kadar yazmış, son aktivite. (S)
- [ ] Panelde "yönetici kişisel alanları göremez" kuralının açıkça gösterilmesi. (S)

**Bitti sayılır:** büyük bir hafızada panel akıcı; bağlayıcı sorunları kullanıcıya görünür.

---

## v0.2 · Hukuki gözden geçirme ve yayın

v0.2 etiketi yalnız şunlar doğruysa:

1. Dört kaynak gerçek hesapla doğrulandı (v0.1.2–v0.1.3).
2. Rıza yaşam döngüsü tam: bildirim, hariç tutma, saklama süresi, silme talebi, offboarding (v0.1.5–v0.1.8).
3. Anahtar yönetimi, yedekleme ve CI hazır (v0.1.9–v0.1.10).
4. Aydınlatma metni, çalışan taahhütnamesi şablonu ve veri sorumlusu bilgileri bir hukuk uzmanına gösterildi. (kod dışı)
5. README'deki "denenmedi" uyarıları kalktı, bilinen sınırlar güncel.

---

## Sonraya (v0.3 ve ötesi)

- **Anlamsal arama:** pgvector ile anlam tabanlı arama.
- **Sor:** hafızaya soru sor, kaynak mesajlarına bağlantılı cevap al (yalnız kullanıcının erişebildiği alanlardan).
- **Medya:** WhatsApp ses mesajları ve belgeler için yazıya çevirme / metin çıkarma.
- **Özetler:** günlük/haftalık ekip özeti, kararlar ve aksiyon maddeleri.
- **Resmî WhatsApp Business API** seçeneği (hesap kısıtlama riski olmadan, daha sınırlı kapsamla).
- **Dışa aktarma ve Obsidian/Notion köprüsü.**

## Açık sorular (karar bekleyen)

- WhatsApp'ta resmî API'ye geçmek mi, `baileys` ile devam edip riski kabul etmek mi? (v0.1.3'ün bulgularına göre.)
- Ayrılan çalışanın kişisel alanı varsayılan olarak silinsin mi, devredilsin mi? (v0.1.7'den önce.)
- Karşı tarafa bildirim konusunda şirketin hukuki görüşü ne? (v0.1.5'in kapsamını belirler.)
