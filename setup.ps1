# =============================================================================
#  iNCompany — Tek Komutlu Kurulum (Windows / PowerShell)
#
#  Kullanım:
#    .\setup.ps1            → bağımlılıkları kurar, sözleşmeyi derler, .env üretir
#    .\setup.ps1 -Demo      → kurulumdan sonra demo sunucusunu başlatır (Docker gerekmez)
#
#  Bu betik YALNIZCA yerel geliştirme içindir. Üretim dağıtımı için
#  docs/05-dagitim-ve-sertlestirme.md içindeki adımları izleyin.
# =============================================================================

param(
    [switch]$Demo
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}

function Write-Ok($text) {
    Write-Host "    OK  $text" -ForegroundColor Green
}

# -----------------------------------------------------------------------------
#  1. Node sürümü kontrolü
# -----------------------------------------------------------------------------
Write-Step "Node.js surumu kontrol ediliyor"

$nodeVersion = (node --version) -replace 'v', ''
$requiredMajor = 20
$actualMajor = [int]($nodeVersion -split '\.')[0]

if ($actualMajor -lt $requiredMajor) {
    Write-Host "    HATA: Node.js >= 20.17 gerekli, bulunan: v$nodeVersion" -ForegroundColor Red
    Write-Host "    https://nodejs.org adresinden guncelleyin." -ForegroundColor Red
    exit 1
}
Write-Ok "Node.js v$nodeVersion"

# -----------------------------------------------------------------------------
#  2. .env dosyası — yoksa örnekten üret ve sırları otomatik doldur
# -----------------------------------------------------------------------------
Write-Step ".env dosyasi hazirlaniyor"

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env

    # `openssl rand -base64` yerine .NET RNG kullanılır — betik openssl
    # kurulu olmayan bir Windows makinesinde de çalışsın diye.
    function New-Secret([int]$bytes) {
        return [Convert]::ToBase64String([byte[]](1..$bytes | ForEach-Object { Get-Random -Maximum 256 }))
    }

    # URL-GÜVENLİ sır: yalnızca alfasayısal karakter üretir.
    #
    # DB/Redis/MinIO parolaları `postgresql://user:PAROLA@host` gibi bir
    # bağlantı URL'sine gömülür. `New-Secret`'in ürettiği base64 çıktısı
    # `/`, `+`, `=` içerebilir — bunlardan biri URL'ye girerse ayrıştırma
    # sessizce yanlış sonuç verir (`+` boşluğa, `/` yol ayracına karışır).
    function New-UrlSafeSecret([int]$length) {
        $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        -join (1..$length | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
    }

    $accessSecret  = New-Secret 48
    $refreshSecret = New-Secret 48
    # TAM 32 BAYT olmalı: CryptoService base64 çözüldüğünde uzunluğu
    # doğrular (bkz. key-management.service.ts). Bu alanı URL-güvenli
    # üreteçle değiştirmeyin — o değişken uzunlukta alfasayısal metin üretir.
    $masterKey     = New-Secret 32
    $pgPassword    = New-UrlSafeSecret 24
    $redisPassword = New-UrlSafeSecret 24
    $minioPassword = New-UrlSafeSecret 24

    # Tek bir metin bloğu üzerinde sırayla değiştir. `-replace` operatörü
    # `MatchEvaluator` (scriptblock) kabul ETMEZ — yalnızca sabit bir
    # değiştirme dizesi alır; bu yüzden her sır için ayrı bir satır gerekir.
    $content = Get-Content .env -Raw
    $content = $content -replace 'degistir_openssl_rand_base64_48_ciktisi_ile', $accessSecret
    $content = $content -replace 'degistir_FARKLI_openssl_rand_base64_48_ciktisi_ile', $refreshSecret
    $content = $content -replace 'degistir_openssl_rand_base64_32_ciktisi_ile', $masterKey
    $content = $content -replace 'POSTGRES_PASSWORD=.*', "POSTGRES_PASSWORD=$pgPassword"
    $content = $content -replace 'DATABASE_URL=postgresql://incompany:[^@]*@', "DATABASE_URL=postgresql://incompany:$pgPassword@"
    $content = $content -replace 'REDIS_PASSWORD=.*', "REDIS_PASSWORD=$redisPassword"
    $content = $content -replace 'REDIS_URL=redis://:[^@]*@', "REDIS_URL=redis://:$redisPassword@"
    $content = $content -replace 'MINIO_ROOT_PASSWORD=.*', "MINIO_ROOT_PASSWORD=$minioPassword"
    $content = $content -replace 'S3_SECRET_KEY=.*', "S3_SECRET_KEY=$minioPassword"
    Set-Content .env -Value $content -Encoding utf8 -NoNewline

    Write-Ok ".env uretildi ve sirlar otomatik dolduruldu"
    Write-Host "    (Uretimde bu dosya KULLANILMAZ - bkz. .env.example basindaki not)" -ForegroundColor DarkGray
} else {
    Write-Ok ".env zaten var, dokunulmadi"
}

# -----------------------------------------------------------------------------
#  3. Bağımlılıklar (workspace kökünden — tüm paketler tek seferde)
# -----------------------------------------------------------------------------
Write-Step "Bagimliliklar kuruluyor (npm install)"
npm install --no-audit --no-fund
Write-Ok "Bagimliliklar kuruldu"

# -----------------------------------------------------------------------------
#  4. Paylaşılan sözleşme paketi — backend ve frontend buna node_modules
#     uzerinden erisir, once derlenmis olmasi gerekir.
# -----------------------------------------------------------------------------
Write-Step "Paylasilan sozlesme deniliyor (@incompany/contracts)"
npm run build --workspace @incompany/contracts
Write-Ok "Sozlesme derlendi"

# -----------------------------------------------------------------------------
#  5. Doğrulama
# -----------------------------------------------------------------------------
Write-Step "Kurulum dogrulaniyor (typecheck)"
npm run typecheck
Write-Ok "Tip kontrolu temiz"

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host "  Kurulum tamamlandi." -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
Write-Host ""

if ($Demo) {
    Write-Host "Demo sunucusu baslatiliyor (Docker gerekmez)..." -ForegroundColor Cyan
    Write-Host "Ayri bir terminalde 'npm run demo:frontend' calistirmayi unutmayin." -ForegroundColor Yellow
    Write-Host ""
    npm run demo
} else {
    Write-Host "Sonraki adimlar:" -ForegroundColor White
    Write-Host ""
    Write-Host "  Docker olmadan hizli deneme (gercek kripto/DLP, bellekte depolama):"
    Write-Host "    npm run demo              " -NoNewline; Write-Host "# terminal 1" -ForegroundColor DarkGray
    Write-Host "    npm run demo:frontend     " -NoNewline; Write-Host "# terminal 2" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Tam ortam (PostgreSQL + Redis + MinIO, Docker gerekir):"
    Write-Host "    npm run docker:up"
    Write-Host ""
    Write-Host "  http://localhost:5173 adresini acin." -ForegroundColor White
}
