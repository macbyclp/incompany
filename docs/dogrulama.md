# Doğrulama kaydı

Bu belge **neyin gerçekten denendiğini** ve neyin hâlâ denenmediğini ayırır. "Denendi" yalnız gerçek bir hesap ya da gerçek
altyapıyla yapılmış turlar için yazılır; örnek olayla yapılan testler ayrı bir sütundadır.

Durumlar: ✅ yapıldı · ⬜ yapılmadı (gerçek hesap/altyapı gerekiyor) · ➖ uygulanamaz

## Özet

| Alan | Örnek olayla otomatik test | Gerçek hesap/altyapıyla |
|---|---|---|
| Telegram | ✅ eşleyici, düzenleme, gruba katılım duyurusu kararı | ⬜ |
| Slack | ✅ eşleyici, düzenleme, silme, alt tipler | ⬜ |
| WhatsApp | ✅ eşleyici, düzenleme/silme güncellemeleri, medya türleri | ⬜ |
| E-posta (IMAP) | ✅ eşleyici, zincir, HTML, alıcılar | ⬜ (imleç/yeniden başlatma/çift yazım) |
| Rıza, kapsam, saklama, aydınlatma sürümü | ✅ (`test/consent.test.ts`, `retention.test.ts`) | ➖ |
| Hariç tutma, KVKK silme/dışa aktarma | ✅ (`privacy.test.ts`, `api.test.ts`) | ➖ |
| Anahtar rotasyonu, RLS, hız sınırı | ✅ (`security.test.ts`) | ⬜ gerçek Postgres'te RLS (yalnız PGlite'ta denendi) |
| Yedek ve geri yükleme | ➖ | ⬜ betikler yazıldı, çalıştırılmadı |
| Caddy ile HTTPS, Docker healthcheck | ➖ | ⬜ |
| Panel | ✅ tarayıcıda gezildi (dev kipi, sahte bağlayıcı) | ⬜ gerçek veriyle büyük hafıza |

**Otomatik testler yeşil ama bağlayıcıları gerçek servislere karşı denemedi.** Canlıya almadan önce aşağıdaki turlar yapılmalı.

## Telegram (gerçek bot)

- [ ] BotFather'dan test botu; `/setprivacy` → Disable; bir test grubuna ekle.
- [ ] Gruba eklenince bot **bilgilendirme mesajını** yazıyor mu? (`my_chat_member` → `sendMessage`)
- [ ] Gruba yazılan mesaj panelde görünüyor, ortak alanda aranıyor mu?
- [ ] Mesajı Telegram'da düzenle → panelde içerik güncelleniyor mu (`edited_message`)?
- [ ] Bilinen: mesajı Telegram'da silmek yansımaz (Bot API bildirmez).
- [ ] "Beni kaydetme" listesine test hesabının kimliğini ekle → yazdığı mesaj kaydedilmiyor mu?

Bulgular: _henüz yok_

## Slack (gerçek uygulama, Socket Mode)

- [ ] Uygulamaya `message.channels`, `message.groups`, `message.im`, `message.mpim`, `member_joined_channel` olayları;
      `chat:write`, `channels:read`, `users:read` yetkileri.
- [ ] Bir kanal ve bir DM'den mesaj geliyor mu?
- [ ] Bot kanala eklenince bilgilendirme mesajı yazılıyor mu?
- [ ] Mesajı düzenle (`message_changed`) ve sil (`message_deleted`): panel birkaç saniyede yansıtıyor mu?

Bulgular: _henüz yok_

## WhatsApp (test numarası)

- [ ] QR eşleştirme; DM `selected` akışı; grup `all`; geçmiş içe alma.
- [ ] Telefondan "bağlı cihazı kaldır" → durum `logged_out`, oturum klasörü silinir, yeniden QR.
- [ ] Düzenleme (`messages.update` + `editedMessage`) ve "herkesten sil" (`messageStubType = REVOKE`) panelde yansıyor mu?
      (Baileys kaynağında bu olaylar böyle üretiliyor; gerçek cihazla doğrulanmadı.)
- [ ] "Beni kaydetme" listesi: telefon numarasıyla eklenen kişi **grup içinde** ve **birebir** yazınca kaydedilmiyor mu?
      Katılımcı `@lid` kimliğiyle gelirse eşleşmiyor olabilir — gerçek veriyle bak.
- [ ] Karar verisi: hesap kısıtlama belirtisi oldu mu? Resmî Business API'ye geçilsin mi?

Bulgular: _henüz yok_

## E-posta (gerçek IMAP kutusu)

- [ ] Yeniden başlatınca imleç kaldığı yerden devam ediyor mu, aynı e-posta çift yazılıyor mu?
- [ ] Konu zinciri (`References`/`In-Reply-To`) doğru toplanıyor mu?
- [ ] Gönderilmiş klasörü eklenirse `fromMe` ve alıcılar doğru mu; hariç tutulan alıcıya giden e-posta atlanıyor mu?
- [ ] `UIDVALIDITY` değişince yeniden tarama (`sinceDays`) çift kayıt üretmiyor mu?

Bulgular: _henüz yok_

## Altyapı

- [ ] `docker compose up -d` sıfırdan; `create-admin`; panel açılıyor.
- [ ] `docker compose --profile https up -d` ile sertifika alınıyor, `TRUST_PROXY=1` ile istemci IP'si doğru görünüyor.
- [ ] `docker inspect` ile uygulamanın `healthy` olduğu görülüyor; Postgres durdurulunca `unhealthy`/503.
- [ ] `ops/backup.sh` → `ops/verify-restore.sh` → boş sunucuda `ops/restore.sh`; rızalar, mesajlar, WhatsApp oturumu geliyor.
- [ ] `APP_SECRET` rotasyonu canlı veritabanında (`rotate-secrets`) sorunsuz.
- [ ] Gerçek Postgres'te RLS: `incompany_reader` rolü oluşuyor, `asUser` çalışıyor (yalnız PGlite'ta denendi;
      yönetilen bir veritabanında rol oluşturma yetkisi gerekebilir).

Bulgular: _henüz yok_

## v0.2 etiketi için

Bu belgedeki ⬜ maddelerin hepsi ✅ olmadan, ayrıca aydınlatma metni ve çalışan taahhütnamesi bir hukuk uzmanına
gösterilmeden v0.2 etiketi verilmez (bkz. [ROADMAP.md](../ROADMAP.md)).
