# incompany

Şirket içi zihin sistemi. WhatsApp, Telegram, Slack ve e-postadan gelen yazışmaları tek bir aranabilir hafızada toplar. Kişisel kaynaklar **rıza olmadan çalışmaz**.

## Nasıl çalışır

- **Hafıza alanları:** her kişinin kendi kişisel alanı, bir ortak şirket alanı ve isteğe bağlı ekip alanları vardır.
- **Şirket botları:** Telegram ve Slack botları eklendikleri grup ve kanallardaki mesajları ortak alana yazar.
- **WhatsApp:** çalışan kendi hesabını QR ile bağlar (WhatsApp Web gibi). Hesap sahibi neyin toplanacağını seçer: birebir sohbetler ve gruplar için `hepsi / ben seçerim / hiçbiri`, geçmiş içe alma ayrı.
- **E-posta:** IMAP kutusu, yalnız sahibinin rızasıyla.
- **Gizlilik:** birebir yazışmalar ve e-postalar yalnız sahibinin kişisel alanına düşer; yönetici dahil kimse göremez. Bir konuşmayı ortak alana yalnız sahibi taşıyabilir.
- **Rıza:** her verme, değiştirme ve geri çekme `consent_log` tablosunda silinmez iz bırakır. Geri çekince oturum anahtarları silinir; toplanmış kayıtları silmek ya da korumak ayrı ve zorunlu bir seçimdir.

## Hızlı deneme (Docker gerekmez)

```bash
npm install
npm run dev
```

Bellek içi veritabanı, sahte bağlayıcılar ve örnek veriyle paneli açar; adres ve yönetici anahtarını yazar.

## Kurulum

```bash
cp .env.example .env   # POSTGRES_PASSWORD ve APP_SECRET (en az 24 karakter) doldurun
docker compose up -d
docker compose exec app node dist/cli.js create-admin "Ad Soyad" ad@sirket.com
```

Panel `127.0.0.1:3000` adresinde açılır. İnternete HTTPS ters vekil (Caddy/nginx) üzerinden çıkın.

## Uyarılar

- WhatsApp bağlayıcısı resmî olmayan bir istemci (baileys) kullanır; WhatsApp hesabı kısıtlayabilir.
- Karşı tarafın mesajları da kayda girer. Çalışan verisi işlemek KVKK kapsamındadır; canlıya almadan önce aydınlatma ve hukuki değerlendirme yapın.
- Bu sürüm (v0.1) gerçek hesaplarla uçtan uca denenmemiştir.

## Geliştirme

```bash
npm test          # PGlite ile rıza ve gizlilik testleri
npm run typecheck
```
