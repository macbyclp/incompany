# Adım 5 — Dağıtım ve Güvenlik Sertleştirmesi

## 5.1 Ortamlar

| Ortam | Amaç | Veri | Erişim |
|---|---|---|---|
| `dev` | Yerel geliştirme (docker-compose) | Sentetik | Geliştirici |
| `staging` | Üretim aynası | **Maskelenmiş** üretim kopyası | Ekip + VPN |
| `prod` | Canlı | Gerçek | Yalnızca otomasyon; insan erişimi break-glass |

**Staging'e üretim verisi maskelenmeden kopyalanmaz.** "Sadece test için" diye alınan bir kopya, en sık görülen kurumsal veri ihlali sebebidir: staging'in kontrolleri daha gevşek, erişimi daha genişitir.

## 5.2 Üretim Topolojisi

```
                    ┌────────────────────────────────────┐
   İnternet ────────▶  WAF (OWASP CRS) + DDoS koruması   │
                    └──────────────┬─────────────────────┘
                                   │ TLS 1.3, HSTS preload
                    ┌──────────────▼─────────────────────┐
                    │  Ingress / L7 LB — TLS terminasyonu│
                    └────┬──────────────────────┬────────┘
                         │                      │
     ═══════════════ DMZ ┼══════════════════════┼═════════════════
                         │  mTLS (mesh)         │  mTLS
                  ┌──────▼───────┐      ┌───────▼────────┐
                  │  API (3-5×)  │      │ Gateway (3×)   │
                  │  HPA: CPU    │      │ HPA: bağlantı  │
                  └──────┬───────┘      └───────┬────────┘
                         │                      │
     ═══════ Uygulama katmanı ══════════════════╧═════════════════
                         │
     ═══════ Veri katmanı (özel alt ağ, internet erişimi YOK) ════
          ┌──────────────┼──────────────┬────────────────┐
    ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼──────┐  ┌──────▼──────┐
    │ PostgreSQL│  │   Redis   │  │ OpenSearch │  │  S3 / MinIO │
    │ Primary   │  │  Cluster  │  │            │  │  SSE-KMS    │
    │  + 2 Read │  │  3 shard  │  │            │  │  Versioning │
    │  PITR yedek│ │           │  │            │  │  Obj. Lock  │
    └───────────┘  └───────────┘  └────────────┘  └─────────────┘
                         │
                   ┌─────▼──────┐
                   │ Vault / KMS│  ← KEK; uygulamaya asla düz anahtar vermez
                   └────────────┘
```

**Otomatik ölçekleme sinyalleri farklıdır:**
- API → CPU ve istek kuyruğu derinliği
- Gateway → **eşzamanlı bağlantı sayısı**. Gateway'i CPU'ya göre ölçeklemek yanlıştır: 8.000 boşta socket neredeyse hiç CPU kullanmaz ama belleği ve dosya tanıtıcılarını (fd) tüketir.

---

# Enterprise Ölçekte 5 Kritik Güvenlik Önlemi

Bu beş madde, "yapılsa iyi olur" listesinden değil; **eksikliği doğrudan ihlale dönüşen** kontrollerdir. Sıralama, gerçek ihlallerdeki katkı payına göredir.

---

## 1. Anahtar ve Sır Yönetimi — Şifrelemenin Değeri Anahtarın Korunması Kadardır

**Neden birinci sırada:** AES-256 kırılmaz. Ama master anahtar ortam değişkeninde duruyorsa, bir SSRF açığı veya bir `docker inspect` çıktısı tüm veritabanını açar. Şifrelenmiş veritabanı sızıntılarının çoğunda şifre kırılmaz — anahtar da beraberinde sızar.

**Uygulama:**

```yaml
# Kubernetes — sır ASLA manifest'te veya imajda bulunmaz
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      serviceAccountName: incompany-api        # IRSA / Workload Identity ile KMS'e bağlı
      automountServiceAccountToken: false      # gerekmiyorsa token bile bağlanmaz
      containers:
        - name: api
          env:
            - name: AWS_KMS_KEY_ID
              value: "arn:aws:kms:eu-central-1:...:key/..."   # kimlik, sır değil
          # Veritabanı parolası Vault Agent tarafından tmpfs'e yazılır,
          # ortam değişkeni OLARAK GEÇİRİLMEZ: env, /proc/<pid>/environ
          # üzerinden okunabilir ve çökme dökümlerine düşer.
          volumeMounts:
            - name: vault-secrets
              mountPath: /run/secrets
              readOnly: true
      volumes:
        - name: vault-secrets
          emptyDir:
            medium: Memory                     # diske asla yazılmaz
```

**Kontrol listesi:**
- [ ] KEK Vault/KMS içinde; sarma-açma işlemi **KMS'in içinde** olur, anahtar sürece inmez
- [ ] IAM politikası asgari: `kms:Encrypt` + `kms:Decrypt`. **`kms:ScheduleKeyDeletion` uygulama rolünde ASLA bulunmaz** — ele geçirilmiş bir uygulama tüm veriyi kalıcı imha edebilir hale gelir
- [ ] Veritabanı kimlik bilgileri kısa ömürlü ve dinamik (Vault DB secrets engine, 1 saat TTL)
- [ ] Depoda sır taraması CI'da zorunlu (`gitleaks`, `trufflehog`) — `pre-commit` yeterli değil, atlanabilir
- [ ] DEK rotasyonu 90 günde bir otomatik; eski sürümler **silinmez** (geçmiş çözülebilmeli)
- [ ] Yedekler ayrı bir KMS anahtarıyla şifrelenir — üretim anahtarı sızarsa yedekler açılmasın

---

## 2. Sıfır Güven Ağ Segmentasyonu — Bir Açık, Tüm Sistem Olmasın

**Neden kritik:** Kurumsal ihlallerin çoğu tek bir kritik açıkla değil, **küçük bir giriş + serbest yanal hareket** ile büyür. Frontend konteynerinde bulunan bir RCE, o konteyner PostgreSQL'e erişebiliyorsa tüm veritabanı demektir.

```yaml
# Varsayılan: HER ŞEY yasak. İzinler açıkça verilir.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# PostgreSQL'e YALNIZCA API ve worker erişir. Gateway'in DB'ye ihtiyacı yoktur.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: postgres-ingress
spec:
  podSelector:
    matchLabels: { app: postgres }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchExpressions:
              - key: app
                operator: In
                values: [incompany-api, incompany-worker]
      ports:
        - protocol: TCP
          port: 5432
```

**Kontrol listesi:**
- [ ] Veri katmanının **giden internet erişimi yok** (veri sızdırma yolunu kapatır)
- [ ] Servisler arası mTLS (Istio/Linkerd) — ağ içi trafik de doğrulanır
- [ ] Yönetim arayüzleri (pgAdmin, Redis Commander, MinIO Console) üretimde **yok**
- [ ] Konteyner sertleştirme: `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, tüm capability'ler `drop: [ALL]`
- [ ] SSH yok; hata ayıklama ephemeral container ile ve denetim kaydına yazılarak
- [ ] Giden trafik beyaz listeli (IdP, KMS, push servisi) — bilinmeyen hedefe çıkış engelli

---

## 3. Kimlik Yaşam Döngüsü — İşten Ayrılan Kişi Sistemden de Ayrılmalı

**Neden kritik:** İçeriden gelen risk, dışarıdan gelenden daha sık gerçekleşir ve daha uzun süre fark edilmez. Ayrılan bir çalışanın hesabı haftalarca açık kalıyorsa, tüm kripto ve ağ önlemleri devre dışıdır — saldırgan zaten yetkili bir kullanıcıdır.

**Sistemdeki karşılığı** (kod tabanında uygulanmış):

| Kontrol | Nerede |
|---|---|
| `token_version` artırımı → tüm erişim token'ları anında geçersiz | [`jwt-auth.guard.ts:128`](../backend/src/auth/guards/jwt-auth.guard.ts) |
| `jti` denylist → tekil oturum iptali | [`jwt-auth.guard.ts:115`](../backend/src/auth/guards/jwt-auth.guard.ts) |
| `session:revoked` yayını → açık socket'ler anında kapanır | [`chat.gateway.ts`](../backend/src/chat/chat.gateway.ts) `revokeUserSessions` |
| Refresh rotasyonu + yeniden kullanım tespiti | `refresh_sessions.family_id` ([şema](../db/postgres/001_schema.sql)) |

**Kontrol listesi:**
- [ ] SCIM 2.0 ile HRIS → iNCompany otomatik provizyon/deprovizyon. **Manuel offboarding güvenilmezdir**
- [ ] IdP'de MFA zorunlu (donanım anahtarı tercih edilir); uygulama MFA'yı kendisi yönetmez
- [ ] Erişim token'ı 15 dk, refresh 7 gün + rotasyon; refresh yeniden kullanımı **tüm aileyi** iptal eder
- [ ] Yönetici işlemleri için step-up authentication (rol atama, veri dışa aktarma)
- [ ] `ADMIN` rolüne sahip hesaplar için ayrı, günlük kullanılmayan kimlikler
- [ ] Çeyreklik erişim gözden geçirmesi (access review) — rol birikmesi (privilege creep) böyle yakalanır
- [ ] Break-glass hesabı: çevrimdışı saklanan kimlik bilgisi, kullanımı otomatik alarm üretir

---

## 4. Tedarik Zinciri ve Çalışma Zamanı Bütünlüğü — Çalıştırdığınız Kodun Yazdığınız Kod Olduğunu Kanıtlayın

**Neden kritik:** Bir Node.js uygulaması tipik olarak 1.000+ geçişli (transitive) bağımlılık taşır. Bunlardan birinin ele geçirilmesi (`event-stream`, `xz-utils`, `ua-parser-js` vakaları) sizin kodunuzdaki hiçbir açığa ihtiyaç duymadan sunucunuzda kod çalıştırır.

```dockerfile
# backend/Dockerfile — üretim aşaması
FROM node:20.17-alpine AS builder
WORKDIR /app
COPY package*.json ./
# `npm ci` — lock dosyasına birebir uyar. `npm install` lock'u güncelleyebilir
# ve derleme, denetlenmemiş bir sürümle yapılabilir.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev

# Distroless: kabuk (shell), paket yöneticisi ve coreutils YOK.
# Bir RCE elde eden saldırgan `curl | sh` yapamaz — araç kutusu boştur.
FROM gcr.io/distroless/nodejs20-debian12:nonroot
WORKDIR /app
COPY --from=builder --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=builder --chown=nonroot:nonroot /app/dist ./dist
USER nonroot
EXPOSE 3000
CMD ["dist/main.js"]
```

**CI kapıları (hepsi bloklayıcı):**

```yaml
- run: npm audit --audit-level=high
- run: npm ci --ignore-scripts          # kurulum betikleri = keyfi kod çalıştırma
- uses: aquasecurity/trivy-action        # imaj CVE taraması
  with: { severity: 'CRITICAL,HIGH', exit-code: '1' }
- run: syft . -o spdx-json > sbom.json   # SBOM üret ve sakla
- run: cosign sign --key $KEY $IMAGE     # imajı imzala
```

**Kontrol listesi:**
- [ ] İmajlar **digest ile** sabitlenir (`@sha256:...`), etiketle değil — etiket yeniden yazılabilir
- [ ] Kubernetes admission controller yalnızca imzalı imajları kabul eder (Sigstore policy-controller)
- [ ] SBOM her sürüm için saklanır — yeni bir CVE çıktığında "etkilendik mi?" sorusu dakikalar içinde yanıtlanır
- [ ] `readOnlyRootFilesystem: true` + gerekli yazma yolları için `emptyDir`
- [ ] Bağımlılık güncellemeleri otomatik PR (Renovate) + insan onayı
- [ ] Çalışma zamanı tespiti (Falco): beklenmeyen süreç, giden bağlantı veya dosya yazımı alarm üretir

---

## 5. Denetlenebilirlik ve Tespit — Göremediğiniz İhlali Durduramazsınız

**Neden kritik:** Ortalama ihlal tespit süresi 200 günün üzerindedir. Önlemeye harcanan çabanın karşılığı, ihlal *olduğunda* ne kadar hızlı görüldüğüyle ölçülür. Ayrıca KVKK, SOX ve ISO 27001 denetimleri **kurcalanamaz** denetim izi ister.

**Sistemdeki karşılığı:**

| Özellik | Uygulama |
|---|---|
| Ekle-yalnız denetim tablosu | `audit_logs` üzerinde UPDATE/DELETE tetikleyiciyle engelli |
| Hash zinciri | Her kayıt bir öncekinin SHA-256'sını içerir → sonradan değişiklik tespit edilir |
| DB seviyesinde yetki | Uygulama rolünden `UPDATE, DELETE ON audit_logs` geri alınmış |
| Yetkisiz erişim izleme | `RolesGuard` her reddi `authz.denied` olarak kaydeder |

**İzlenmesi gereken sinyaller** (bunlar olmadan denetim kaydı yalnızca uyum belgesidir, güvenlik aracı değil):

| Sinyal | Eşik | Anlamı |
|---|---|---|
| `authz.denied` (tek kullanıcı) | > 10 / 5 dk | Yetki tarama — hesap ele geçirilmiş olabilir |
| `file.download` (tek kullanıcı) | > 50 / saat | Toplu veri sızdırma |
| `dlp.blocked` | > 5 / gün / kullanıcı | Kasıtlı sızdırma denemesi veya eğitim ihtiyacı |
| Yeni ülke/cihazdan giriş | herhangi | Kimlik bilgisi hırsızlığı |
| `role.assign` → ADMIN | herhangi | Yetki yükseltme |
| Denetim zinciri kırılması | herhangi | **Aktif kurcalama — en yüksek öncelik** |
| Mesai dışı yönetici işlemi | herhangi | İnceleme gerektirir |

**Kontrol listesi:**
- [ ] Denetim kayıtları SIEM'e (Splunk/Sentinel) **gerçek zamanlı** akar
- [ ] Uzun süreli kopya S3 Object Lock (WORM, compliance mode) ile — root bile silemez
- [ ] Loglarda **PII yok**: mesaj içeriği, TCKN, token asla loglanmaz. Kullanıcı kimliği UUID olarak
- [ ] Hash zinciri doğrulaması günlük planlı görev; kırılma sayfa (page) üretir
- [ ] Log saklama süresi ≥ yasal gereklilik (KVKK/SOX genelde 2–7 yıl)
- [ ] Olay müdahale tatbikatı 6 ayda bir — plan test edilmediyse plan değildir
- [ ] Dağıtık izleme (OpenTelemetry) `trace_id` ile denetim kaydına bağlı: bir olay, tüm istek zincirine kadar sürülebilir

---

## 5.3 Bu Beşin Dışında — Sık Atlanan Ama Gerekli

| Konu | Not |
|---|---|
| **Dosya taraması** | Yüklenen her dosya ClamAV'den geçer; `av_status: PENDING` iken indirme bağlantısı **verilmez** |
| **İçerik tipi doğrulama** | MIME sihirli bayt ile doğrulanır, uzantıya güvenilmez |
| **Dosya sunumu** | Kullanıcı yüklemeleri ayrı bir origin'den (`files.incompany.com`) `Content-Disposition: attachment` ile sunulur — ana origin'de saklanan HTML, XSS'e dönüşür |
| **Yedek testi** | Geri yükleme ayda bir gerçekten denenir. Test edilmemiş yedek, yedek değildir |
| **PITR** | PostgreSQL point-in-time recovery, WAL arşivi ile ≥ 30 gün |
| **Rate limit** | Kullanıcı + IP + tenant seviyelerinde ayrı ayrı |
| **CSP** | `default-src 'self'; script-src 'self'; frame-ancestors 'none'; object-src 'none'` |
| **Bağımlılık lisansları** | Kurumsal dağıtımda GPL bulaşması hukuki risktir |

## 5.4 Üretime Geçiş Kapısı

Aşağıdakiler tamamlanmadan üretime çıkılmaz:

- [ ] Bağımsız sızma testi (penetration test) yapıldı, kritik ve yüksek bulgular kapatıldı
- [ ] Yük testi: hedef eşzamanlı kullanıcının 2 katı, p99 < 200 ms
- [ ] Kaos testi: gateway düğümü öldürüldüğünde istemciler kayıpsız yeniden bağlandı
- [ ] Yedekten geri yükme tatbikatı başarılı
- [ ] Olay müdahale runbook'u yazıldı ve masa başı tatbikatı yapıldı
- [ ] KVKK/GDPR: veri işleme envanteri, saklama politikaları, silme hakkı akışı hazır
- [ ] Kullanıcı bilgilendirmesi: hangi verinin toplandığı, kimin görebildiği, ne kadar saklandığı açıkça yazıldı
