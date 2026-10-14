# İşletim: kurulum, HTTPS, yedek, sağlık

Bu belge sistemi ayağa kaldırmak ve ayakta tutmak içindir. Güvenlik modeli için [guvenlik.md](guvenlik.md).

## 1. Kurulum

```bash
cp .env.example .env      # POSTGRES_PASSWORD ve APP_SECRET (en az 24 karakter) doldur
docker compose up -d
docker compose exec app node dist/cli.js create-admin "Ad Soyad" ad@sirket.com
```

Panel yalnız `127.0.0.1:3000` adresinde açılır. İnternete açmak için aşağıdaki HTTPS adımını kullan.

## 2. HTTPS (Caddy ile otomatik sertifika)

Gerekenler: bu sunucuya yönlenmiş bir alan adı, açık 80 ve 443 portları.

`.env` dosyasına ekle:

```
DOMAIN=hafiza.sirketim.com.tr
TRUST_PROXY=1
```

```bash
docker compose --profile https up -d
```

Caddy sertifikayı Let's Encrypt'ten kendisi alır ve yeniler (`caddy_data` birimi). `TRUST_PROXY=1`, istemci IP'sinin
`X-Forwarded-For`'dan okunmasını sağlar; bunsuz hız sınırı ve deneme kilidi herkesi tek IP (Caddy) sayar.
**Caddy'siz, doğrudan internete açma**: o durumda `TRUST_PROXY` açık kalmamalı (başlık sahtelenebilir).

## 3. Sağlık

| Nerede | Ne gösterir |
|---|---|
| `GET /health` (herkese açık) | `{ok, db, connectors:{total, connected, problems, waiting}}`. Veritabanı yoksa **503**. Etiket/kimlik içermez. Docker `HEALTHCHECK` bunu kullanır. |
| `GET /health/connectors` (yönetici) | Sorunlu bağlayıcıların etiketi, hata iletisi ve son başarılı eşitleme anı. |
| Panel → Genel bakış | Sahibine kendi kaynaklarının, yöneticiye şirket botlarının sorunu sarı uyarıyla görünür. |
| Panel → Kaynaklar | Her kaynakta durum, hata iletisi, "son başarılı eşitleme" ve **Yeniden başlat** düğmesi. |

Bağlayıcı sorunları (`error`, `logged_out`, `reconnecting`) `/health`'i 503 yapmaz; yalnız `connectors.problems` sayısını
artırır. Dış izleme kullanıyorsan bu sayıyı ayrıca uyarıya bağla.

## 4. Yedek ve geri yükleme

Yedeklenmesi gereken üç şey var:

1. **Veritabanı** (`ops/backup.sh`): tüm mesajlar, rıza ve denetim kayıtları, **şifreli** bağlayıcı sırları.
2. **Uygulama verisi** (`ops/backup.sh`): WhatsApp oturum klasörleri. Bunsuz her WhatsApp hesabı QR'ı yeniden okutmalıdır.
3. **`.env` (özellikle `APP_SECRET`)**: **yedeğe girmez, ayrıca ve güvenli saklanır.** Bağlayıcı sırları `APP_SECRET`
   ile şifrelidir; geri yüklenen veritabanı bu anahtar olmadan okunamaz. (Yedek ile anahtarı aynı yerde tutmak
   şifrelemeyi anlamsız kılar; ayrı yerlerde tut.)

```bash
ops/backup.sh backups                                  # db-ZAMAN.dump + data-ZAMAN.tgz üretir ve bütünlüğünü okur
ops/verify-restore.sh backups/db-20261014-020000.dump  # canlıya dokunmadan geçici veritabanına geri yükleyip sayar
ops/restore.sh backups/db-....dump backups/data-....tgz  # CANLININ ÜZERİNE YAZAR; 'evet' sorar
```

Önerilen düzen: `ops/backup.sh` günlük (cron), `ops/verify-restore.sh` haftalık. Geri yüklenemeyen yedek yedek değildir.

> **Durum:** bu betikler yazıldı ve `bash -n` ile sözdizimi denetlendi, ama geliştirme makinesinde Docker/Postgres
> olmadığı için **uçtan uca çalıştırılıp doğrulanmadı**. Canlıya almadan önce bir deneme sunucusunda şu turu yap:
> kur → veri ekle → `backup.sh` → boş bir sunucuda `restore.sh` → panelde verilerin ve rızaların geldiğini gör.
> Sonucu [dogrulama.md](dogrulama.md)'ye yaz.

## 5. Anahtar rotasyonu (`APP_SECRET`)

Anahtar sızdıysa ya da periyodik yenileme için:

1. Yeni bir `APP_SECRET` üret (en az 24 karakter).
2. `.env`: `APP_SECRET=<yeni>` ve `APP_SECRET_PREVIOUS=<eski>`. `docker compose up -d` (uygulama iki anahtarla da okur).
3. Kayıtları yeni anahtarla yeniden şifrele:
   ```bash
   docker compose exec app node dist/cli.js rotate-secrets
   ```
   İşlem tek veritabanı işlemidir: okunamayan bir kayıt varsa hiçbiri değişmez.
4. `{N} kayıttan {N} tanesi yeniden şifrelendi` çıktısını gör; sonra `.env`'den `APP_SECRET_PREVIOUS`'ı sil, `up -d`.

Eski (v0.1) kayıtlar tek SHA-256 ile şifrelidir; okunmaya devam eder ve ilk `rotate-secrets` ile yeni biçime (scrypt) çevrilir.

## 6. Saklama süresi ve temizlik

Süresi dolan mesajlar açılışta ve her 6 saatte silinir. Kişisel kaynaklarda süreyi hesap sahibi rıza kapsamında seçer;
Telegram/Slack için şirket süresi panelde **Gizlilik ve KVKK** altındadır.

## 7. Güncelleme

```bash
git pull && docker compose build app && docker compose up -d
```

Şema göçleri açılışta otomatik uygulanır (`schema_migrations`). Güncellemeden önce `ops/backup.sh` çalıştır.
