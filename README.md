<div align="center">

<img src="docs/logo.svg" width="84" alt="incompany logosu">

# incompany

**Şirketin ortak hafızası. Rızasız hiçbir şey toplamaz.**

WhatsApp, Telegram, Slack ve e-postadaki yazışmaları tek bir aranabilir hafızada toplar.<br>
Kişisel kaynaklar, sahibi açıkça onay vermeden çalışmaz.

![sürüm](https://img.shields.io/badge/sürüm-v0.1.11-0f766e?style=flat-square)
![node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white)
![typescript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)
![postgres](https://img.shields.io/badge/PostgreSQL-4169e1?style=flat-square&logo=postgresql&logoColor=white)
![docker](https://img.shields.io/badge/Docker-hazır-2496ed?style=flat-square&logo=docker&logoColor=white)

[Hızlı deneme](#-hızlı-deneme) · [Kurulum](#-kurulum) · [Nasıl çalışır](#-nasıl-çalışır) · [Gizlilik ve rıza](#-gizlilik-ve-rıza) · [Uyarılar](#-uyarılar)

</div>

<br>

<p align="center">
  <img src="docs/panel-genel-bakis.jpg" width="49%" alt="Genel bakış ekranı">
  <img src="docs/panel-kaynaklar.jpg" width="49%" alt="Kaynaklar ekranı">
</p>

## ✨ Neler yapar

| | |
|---|---|
| 💬 **Tek hafıza** | WhatsApp, Telegram, Slack ve e-posta tek yerde, Türkçe tam metin aramayla. |
| 🤝 **Rıza önce gelir** | WhatsApp ve e-posta, hesap sahibi kapsamı seçip onaylamadan hiçbir şey saklamaz. |
| 🔒 **Kişisel alan korunur** | Birebir yazışmalar ve e-postalar yalnız sahibine görünür; yönetici dahil kimse göremez. |
| 🧭 **Seçim sahibinde** | Birebir sohbetler ve gruplar için `hepsi`, `ben seçerim` ya da `hiçbiri`. |
| 🧾 **Silinmez iz** | Her rıza, değişiklik ve geri çekme kayıt altına alınır; yönetici işlemleri ayrı bir denetim kaydında tutulur. |
| 🚫 **Beni kaydetme** | Listeye eklenen kişinin mesajı hiçbir kaynaktan kaydedilmez. Botlar gruba girince grubu bilgilendirir. |
| ⏳ **Saklama süresi** | Süresi dolan mesajlar kendiliğinden silinir. Aydınlatma metni değişince herkes yeniden onaylayana kadar toplama durur. |
| 📜 **KVKK talebi** | Bir kişinin verisini dışa aktar (JSON/CSV) ya da kişisel alanlar dahil her yerden sil. |
| 👋 **Ayrılan çalışan** | Anahtarı kesilir, bağlantıları durur, kişisel alanı silinir ya da devredilir. |
| 🛡️ **Veritabanı da korur** | Satır düzeyi güvenlik: bir sorgu hatası bile başkasının kişisel mesajını sızdırmaz. |
| 🖥️ **Hazır panel** | Genel bakış, kaynaklar, konuşmalar (sayfalı), arama, rıza geçmişi, ekip, gizlilik ve denetim. |
| 🐳 **Kendi sunucunda** | Docker Compose, otomatik HTTPS (Caddy), yedek ve geri yükleme betikleriyle; verin senin sunucunda kalır. |

## 🧩 Nasıl çalışır

```mermaid
flowchart LR
  subgraph Kaynaklar
    WA[WhatsApp<br/>QR ile bağlı hesap]
    TG[Telegram botu]
    SL[Slack uygulaması]
    EM[E-posta<br/>IMAP]
  end
  RIZA{Rıza ve kapsam<br/>süzgeci}
  WA --> RIZA
  EM --> RIZA
  TG --> ORT
  SL --> ORT
  RIZA -->|DM ve e-posta| KIS[(Kişisel alan<br/>yalnız sahibi)]
  RIZA -->|gruplar| KIS
  KIS -. "sahibi açıkça taşırsa" .-> ORT[(Ortak şirket alanı)]
  KIS --> ARA[Arama ve panel]
  ORT --> ARA
```

- **Hafıza alanları:** herkesin bir kişisel alanı, bir ortak şirket alanı ve isteğe bağlı ekip alanları vardır.
- **Şirket botları:** Telegram ve Slack botları, eklendikleri grup ve kanallardaki mesajları ortak alana yazar. Bunları yalnız yönetici kurar.
- **WhatsApp:** çalışan kendi hesabını QR ile bağlar (WhatsApp Web gibi). Telefon bağlantıyı koparırsa oturum anahtarları silinir.
- **E-posta:** IMAP kutusu; okunan konum saklanır, aynı e-posta iki kez yazılmaz.

## 🔒 Gizlilik ve rıza

Sistemin asıl vaadi bu bölüm. Kurallar kodda uygulanır, yalnız arayüzde değil:

1. **Rıza yoksa kayıt yok.** Bağlayıcı yanlışlıkla çalışsa bile kayıt katmanı mesajı atar.
2. **Rızayı yalnız hesap sahibi verir.** Yönetici onun yerine veremez.
3. **Kapsam açıkça seçilir.** Varsayılan yok: DM, grup ve geçmiş içe alma ayrı ayrı sorulur.
4. **DM'ler kişisel alanda kalır.** Ortak alana yalnız sahibi taşıyabilir.
5. **Geri çekmek kolay.** Oturum anahtarları silinir; toplanmış kayıtları silmek ya da korumak ayrı ve zorunlu bir seçimdir.
6. **Her şey kayıtlı.** Rıza geçmişi silinmez ve panelde görünür; her rıza hangi aydınlatma metni sürümüne verildiğini de taşır.
7. **Karşı taraf hariç tutulabilir.** "Beni kaydetme" listesi ingest katmanında, her kaynakta uygulanır; telefon numarası her biçimiyle eşleşir.
8. **Süre sınırı sahibindedir.** Saklama süresi rıza kapsamındadır; metin değişirse onay yenilenene kadar toplama durur.
9. **Yönetici kişisel alanı göremez.** Ne konuşma listesinde, ne aramada, ne veri talebinde; veritabanı da bunu ayrıca uygular.

Güvenlik modelinin ayrıntısı ve **sınırları**: [docs/guvenlik.md](docs/guvenlik.md).

## 🚀 Hızlı deneme

Docker ya da veritabanı kurmadan, sahte bağlayıcılar ve örnek veriyle paneli aç:

```bash
git clone https://github.com/macbyclp/incompany.git
cd incompany
npm install
npm run dev
```

Çıktıdaki adresi tarayıcıda açıp yazdırdığı yönetici anahtarıyla giriş yap. Bellek içi çalışır, hiçbir şey diske yazılmaz.

## 📦 Kurulum

```bash
cp .env.example .env      # POSTGRES_PASSWORD ve APP_SECRET (en az 24 karakter) doldur
docker compose up -d
docker compose exec app node dist/cli.js create-admin "Ad Soyad" ad@sirket.com
```

Panel `127.0.0.1:3000` adresinde açılır. İnternete açmak için `.env`'e `DOMAIN` ve `TRUST_PROXY=1` ekleyip
`docker compose --profile https up -d` çalıştır (otomatik sertifika). Yedek, geri yükleme, anahtar rotasyonu ve sağlık için:
**[docs/isletim.md](docs/isletim.md)**.

<details>
<summary><b>Kaynakları bağlama</b></summary>

<br>

| Kaynak | Ne gerekir |
|---|---|
| **Telegram** | BotFather'dan bot anahtarı. Grup mesajlarını görmesi için `/setprivacy` → Disable. |
| **Slack** | Socket Mode açık bir uygulama: `xoxb-` bot anahtarı ve `xapp-` uygulama anahtarı. |
| **WhatsApp** | Panelden kaynağı ekle, rıza kapsamını seç, çıkan QR'ı telefonda *Bağlı cihazlar → Cihaz bağla* ile okut. |
| **E-posta** | IMAP sunucusu, kullanıcı adı ve parola. Gmail için uygulama şifresi kullan. |

</details>

<details>
<summary><b>Ortam değişkenleri</b></summary>

<br>

| Değişken | Açıklama |
|---|---|
| `DATABASE_URL` | PostgreSQL bağlantı adresi |
| `APP_SECRET` | Kayıtlı anahtarları şifrelemek için, en az 24 karakter |
| `APP_SECRET_PREVIOUS` | Rotasyon sırasında eski `APP_SECRET` değer(ler)i, virgülle ayrılmış |
| `TRUST_PROXY` | `1`: istemci IP'si `X-Forwarded-For`'dan okunur (yalnız ters vekil arkasında) |
| `DOMAIN` | `--profile https` için alan adı |
| `DATA_DIR` | Bağlayıcı oturum dosyaları (varsayılan `./data`) |
| `PORT`, `HOST` | Dinlenen port ve adres (varsayılan `3000`, `0.0.0.0`) |

</details>

## ⚠️ Uyarılar

- **WhatsApp bağlayıcısı resmî değil.** `baileys` kütüphanesi kullanılır; WhatsApp hesabı kısıtlayabilir. Kritik kullanımda resmî Business API düşünülmeli.
- **Karşı tarafın mesajları da kayda girer.** Çalışan verisi işlemek KVKK kapsamındadır; canlıya almadan önce aydınlatma ve hukuki değerlendirme yap.
- **Gerçek hesaplarla uçtan uca denenmedi.** Rıza, gizlilik, düzenleme/silme, saklama, KVKK ve güvenlik kuralları örnek olaylarla
  otomatik test edilir (107+ test); canlı WhatsApp, Telegram, Slack ve IMAP turu, yedekten geri yükleme ve HTTPS henüz
  yapılmadı. Neyin denendiği, neyin beklediği: [docs/dogrulama.md](docs/dogrulama.md).
- **Telegram'da silinen mesaj yansımaz** (Bot API bildirmez); düzenleme yansır.
- **Aydınlatma metni taslaktır.** Hukuk uzmanına gösterilmeden gerçek çalışan verisiyle kullanma.
- **Satır düzeyi güvenlik** sorgu hatalarına karşı savunma derinliğidir, SQL enjeksiyonuna karşı bariyer değildir ([sınır](docs/guvenlik.md#satır-düzeyi-güvenlik-rls)).

## 🛠️ Geliştirme

```bash
npm test            # PGlite ile rıza, gizlilik, güvenlik ve API testleri
npm run typecheck
npm run build
npm run cli -- rotate-secrets   # APP_SECRET rotasyonu (docs/isletim.md)
```

Yol haritası: [ROADMAP.md](ROADMAP.md).

<div align="center">
<sub>Neyin toplanacağına, hesabın sahibi karar verir.</sub>
</div>
