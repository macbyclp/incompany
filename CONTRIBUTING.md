# Katkıda Bulunma Rehberi

iNCompany'e katkı vermek istediğiniz için teşekkürler. Bu proje güvenlik
kritik bir sistemdir (şifreleme, kimlik doğrulama, DLP); bu yüzden katkı
süreci sıradan bir projeye göre biraz daha titizdir.

## Geliştirme Ortamı Kurulumu

```bash
git clone https://github.com/<kullanici-adi>/incompany.git
cd incompany
./setup.sh        # Linux/macOS — Windows için: .\setup.ps1
```

Bu betik bağımlılıkları kurar, `.env`'i sırlar otomatik doldurulmuş şekilde
üretir ve sözleşme paketini derler. Elle kurulum adımları için [README.md § Hızlı Başlangıç](README.md#hızlı-başlangıç)'a bakın.

Docker olmadan hızlı deneme (bellek içi depolama, gerçek kripto/DLP):

```bash
npm run demo --workspace @incompany/backend
npm run dev --workspace @incompany/frontend
```

Tam ortam (PostgreSQL + Redis + MinIO):

```bash
cp .env.example .env
# .env içindeki sırları openssl rand -base64 32/48 ile doldurun
docker compose up -d
```

## Değişiklik Göndermeden Önce

Aşağıdakilerin **hepsi** yeşil olmalıdır — CI aynı kontrolleri çalıştırır ve
kırmızıysa PR birleştirilemez:

```bash
npm run typecheck   # 3 paket
npm test             # backend 57+ test, frontend 17+ test
npm run build        # backend/dist/main.js, frontend/dist/
npm run lint
```

Güvenlik kritik dosyalarda (`common/crypto`, `auth/guards`, `dlp`,
`chat/sanitize.ts`) test kapsamı eşiği %90-100'dür ([vitest.config.ts](backend/vitest.config.ts)).
Bu dosyalardan birine dokunuyorsanız yeni davranışı test eden bir test
eklemeden PR açmayın.

## Kod Standartları

- **TypeScript strict mode zorunludur.** `any` kullanmayın; kaçınılmazsa
  yorumla gerekçelendirin.
- **Yorumlar "ne" değil "neden" anlatır.** Kod zaten neyi yaptığını söyler;
  yorum, o kararın alternatifine göre neden tercih edildiğini anlatmalıdır.
  Mevcut kod tabanındaki yorum yoğunluğunu örnek alın.
- **Güvenlik kararları asla sessizce değiştirilmez.** `fail-open` /
  `fail-closed` seçimi, AAD bağlama, RLS politikası gibi kararları
  değiştiren bir PR, gerekçesini açıkça yazmalıdır.
- **Yeni bir HTTP veya WebSocket uç noktası eklerken** DTO doğrulaması
  (`class-validator`) ve yetki kontrolü (`@RequirePermissions` veya
  `ChannelPolicyService`) zorunludur — bkz. [chat.gateway.ts](backend/src/chat/chat.gateway.ts).

## PR Süreci

1. Bir issue açın veya var olanı yorumlayın — büyük değişikliklerde önce
   yaklaşımı tartışmak, reddedilen bir PR'dan daha az zaman kaybettirir.
2. Dalı `main`'den türetin: `git checkout -b ozellik/kisa-aciklama`.
3. Küçük, odaklı commit'ler yapın. Commit mesajı ne'yi değil neden'i anlatsın.
4. PR açıklamasına şunu ekleyin: ne değişti, neden, nasıl test edildi.
5. Güvenlik kritik bir değişiklikse (kripto, auth, DLP, RLS) açıklamada
   açıkça belirtin — bu PR'lar ek inceleme alır.

## Güvenlik Açıkları

Genel bir issue **açmayın**. [SECURITY.md](SECURITY.md)'deki süreci izleyin.

## Davranış Kuralları

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) dosyasına bakın.
