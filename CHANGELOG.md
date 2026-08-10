# Değişiklik Günlüğü

Bu proje [Semantic Versioning](https://semver.org/lang/tr/) kullanır.
Biçim [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) temel alınmıştır.

## [Yayınlanmamış]

### Eklenenler

- **Kurulum sihirbazı**: gerçek bir dağıtım artık tamamen boş başlar (sıfır
  kanal, sıfır kullanıcı). `organizations` tablosu boşken uygulama otomatik
  olarak organizasyon + ilk yönetici hesabı oluşturma ekranı gösterir
  (`SetupService`, `SetupController`, tek-seferlik veritabanı kilidiyle
  korunur — bkz. `pg_advisory_xact_lock`).
- **Parola ile giriş**: SSO'yu henüz yapılandıramayan ilk yönetici için
  (ve isteğe bağlı diğer yerel hesaplar için) `AuthService.loginWithPassword`.
  Node.js'in yerleşik `scrypt`'i ile karma alınır — native bağımlılık yok.
- **Demo/gerçek kurulum ayrımı arayüzde görünür kılındı**: demo modunda
  (`npm run demo`) kalıcı, kapatılamaz bir banner gösterilir.

### Düzeltilen hatalar

- App.tsx'te kurulum-durumu sorgusu ile oturum-açma denemesi aynı
  `try/catch` bloğunda birleşikti; kurulum sorgusu başarısız olduğunda
  (eski sunucu, ağ hatası) geçerli bir refresh çerezi olan kullanıcı bile
  giriş ekranına düşüyordu. İki adım bağımsız hata yönetimine ayrıldı.

## [0.1.0] — İlk açık kaynak yayını

### Eklenenler

**Çekirdek platform**
- JWT + refresh token rotasyonu (yeniden kullanım tespitiyle), OIDC/PKCE SSO
- Hiyerarşik RBAC + ince taneli izin sistemi
- WebSocket gerçek zamanlı gateway: kanal aboneliği, yazıyor göstergesi, varlık durumu
- AES-256-GCM zarf şifreleme (AAD bağlamalı), KMS soyutlaması (yerel/AWS)
- DLP motoru: TCKN, kredi kartı, IBAN, AWS anahtarı, PEM, JWT tespiti — maskeleme/engelleme
- Denetim izi: ekle-yalnız tablo + hash zinciri + DB seviyesinde koruma
- Kanal türleri: DM, grup, departman, duyuru (salt-yaz kısıtlı)
- Mesaj gönderme/düzenleme/silme — düzenleme ve gönderim aynı DLP+şifreleme yolunu paylaşır
- Kanal üye yönetimi: listeleme, ekleme, çıkarma
- Saklama politikaları: `DROP PARTITION` ile silme, legal hold desteği

**Arayüz**
- Kenar çubuğu: sabitlenenler/kanallar/DM gruplaması, arama, okunmamış rozetleri
- Ayarlar: profil, tema (açık/koyu/sistem), bildirimler + sessiz saatler, durum, oturumlar
- Yönetim paneli: kullanıcı listeleme/oluşturma/rol atama/askıya alma
- Sanallaştırılmış mesaj listesi, tarih ayraçları, Markdown + DOMPurify render
- Erişilebilirlik: odak tuzağı, `aria-live` bölgeleri, klavye navigasyonu

**Altyapı**
- npm workspaces (backend, frontend, paylaşılan sözleşme paketi)
- Docker Compose (PostgreSQL + Redis + MinIO) — geliştirme ortamı
- Bellek içi demo sunucusu (`npm run demo`) — Docker olmadan gerçek kripto/DLP denemesi
- GitHub Actions CI: sır taraması → lint/tip/test → şema doğrulaması → güvenlik taraması → imaj derlemesi

### Bilinen Sınırlar

- AV tarama worker'ı yazılmadı — dosya indirme fail-closed durur (`av_status` hiç `CLEAN` olmaz)
- OpenSearch indeksleyici yazılmadı — outbox olayları üretiliyor, tüketici yok
- Presence yayını organizasyon geneli — ~1.000 kullanıcı üzerinde daraltma gerekir
- Docker imajları bu ortamda derlenip doğrulanamadı (Docker kurulu değildi)

Ayrıntılar için [README.md § Bilinen Sınırlar](README.md#bilinen-sınırlar).
