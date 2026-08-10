# Güvenlik Politikası

iNCompany kurumsal iç iletişim için tasarlanmıştır ve şifreleme, DLP, denetim
kaydı gibi güvenlik kritik bileşenler içerir. Bir güvenlik açığı bulduysanız
lütfen aşağıdaki yolu izleyin.

## Açık Bulduğunuzda Ne Yapmalısınız

**Genel bir GitHub issue AÇMAYIN.** Açık bir issue, düzeltme yayınlanmadan
önce saldırganlara yol gösterir.

Bunun yerine:

1. GitHub'da **Security → Advisories → Report a vulnerability** üzerinden
   özel bir bildirim açın, veya
2. Depo sahibine doğrudan mesaj gönderin.

Bildiriminize şunları ekleyin:

- Açığın türü (ör. kimlik doğrulama atlatma, şifreleme zafiyeti, XSS, SQL
  enjeksiyonu)
- Etkilenen dosya(lar) ve satır numaraları (biliniyorsa)
- Yeniden üretme adımları veya kavram kanıtı (proof-of-concept)
- Potansiyel etki

## Yanıt Süreci

- 48 saat içinde bildiriminizi aldığımızı onaylarız.
- 7 gün içinde ilk değerlendirmeyi paylaşırız (ciddiyet, kapsam).
- Düzeltme, ciddiyetine göre önceliklendirilir; kritik açıklar için hedef
  30 gündür.
- Düzeltme yayınlandıktan sonra, sizinle koordineli olarak (isterseniz
  isminizle) kamuya açıklama yapılır.

## Kapsam İçi

- `backend/src/common/crypto/**` — şifreleme ve anahtar yönetimi
- `backend/src/auth/**` — kimlik doğrulama, JWT, oturum yönetimi
- `backend/src/dlp/**` — veri sızıntısı önleme
- `backend/src/chat/sanitize.ts` — XSS ve girdi temizleme
- `db/postgres/001_schema.sql` — Row Level Security politikaları, denetim
  zinciri bütünlüğü

## Kapsam Dışı

- `backend/scripts/dev-server.ts` — yalnızca yerel demo amaçlıdır, üretimde
  hiçbir şekilde kullanılmaz ve kalıcılık/yetkilendirme taklit eder
- Üçüncü taraf bağımlılıklardaki açıklar (bunun yerine ilgili projeye
  bildirin; ancak bize de haber verirseniz bağımlılığı güncelleriz)
- Kullanıcının kendi ortamındaki yanlış yapılandırmalar (örn. üretimde
  `KMS_PROVIDER=local` kullanmak — kod bunu zaten reddeder)

## Bilinen Sınırlar

Bunlar açık değildir, tasarım kararlarıdır ve dokümante edilmiştir:

- **Mod A (varsayılan) şifreleme sunucu tarafındadır.** Veritabanı sızıntısına
  karşı korur, ele geçirilmiş bir uygulama sunucusuna karşı korumaz. Bkz.
  [docs/01-mimari.md §1.4](docs/01-mimari.md).
- **AV tarama worker'ı henüz yazılmadı.** Bu yüzden `av_status` hiçbir zaman
  `CLEAN` olmaz ve dosya indirme uçtan uca çalışmaz — bu kasıtlı bir
  fail-closed davranıştır, açık değildir.
