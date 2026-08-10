#!/usr/bin/env bash
# =============================================================================
#  iNCompany — Tek Komutlu Kurulum (Linux / macOS)
#
#  Kullanım:
#    ./setup.sh          → bağımlılıkları kurar, sözleşmeyi derler, .env üretir
#    ./setup.sh --demo   → kurulumdan sonra demo sunucusunu başlatır (Docker gerekmez)
#
#  Windows için: setup.ps1 kullanın.
# =============================================================================

set -euo pipefail

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32mOK\033[0m  %s\n' "$1"; }
err()  { printf '    \033[31mHATA\033[0m  %s\n' "$1" >&2; }

# -----------------------------------------------------------------------------
#  1. Node sürümü kontrolü
# -----------------------------------------------------------------------------
step "Node.js surumu kontrol ediliyor"

if ! command -v node >/dev/null 2>&1; then
  err "Node.js bulunamadi. https://nodejs.org adresinden kurun (>= 20.17)."
  exit 1
fi

node_major=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$node_major" -lt 20 ]; then
  err "Node.js >= 20.17 gerekli, bulunan: $(node --version)"
  exit 1
fi
ok "$(node --version)"

# -----------------------------------------------------------------------------
#  2. .env dosyası — yoksa örnekten üret ve sırları otomatik doldur
# -----------------------------------------------------------------------------
step ".env dosyasi hazirlaniyor"

if [ ! -f .env ]; then
  cp .env.example .env

  # `openssl` neredeyse her Linux/macOS kurulumunda vardır; yoksa /dev/urandom'a düşülür.
  #
  # ÇIKTI HER ZAMAN `\r\n` DEĞİL YALNIZCA `\n` OLARAK TEMİZLENİR
  # (`tr -d '\r\n'`, `tr -d '\n'` DEĞİL): Windows üzerindeki bazı `openssl`
  # derlemeleri (Git for Windows dahil) satır sonunu CRLF yazar. Yalnızca
  # `\n` silinirse sıra dışı bir `\r` sırrın içine sızar — base64 çözme
  # sırasında ya hata verir ya da yanlış uzunlukta bir anahtar üretir.
  gen_b64() {
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -base64 "$1" | tr -d '\r\n'
    else
      head -c "$1" /dev/urandom | base64 | tr -d '\r\n'
    fi
  }

  # URL-güvenli sır: yalnızca [0-9a-f] üretir.
  #
  # DB/Redis/MinIO parolaları `postgresql://user:PAROLA@host` gibi bir
  # bağlantı URL'sine gömülür. base64 çıktısı `/`, `+`, `=` içerebilir —
  # bunlardan biri URL'ye girerse ayrıştırma sessizce yanlış sonuç verir.
  # Hex, doğası gereği URL-güvenlidir ve ekstra bir filtreleme adımı
  # gerektirmez.
  #
  # NOT: `tr -dc 'A-Za-z0-9' < /dev/urandom | head -c N` KULLANILMAZ.
  # Bu boru hattı MSYS/Git-Bash altında art arda çağrıldığında (`head`in
  # erken kapanması `tr`e SIGPIPE gönderdiğinde) tutarsız biçimde askıda
  # kalabiliyor — `openssl rand -hex` bu riski taşımadan aynı işi yapar.
  gen_hex() {
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex "$1" | tr -d '\r\n'
    else
      head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \r\n'
    fi
  }

  access_secret=$(gen_b64 48)
  refresh_secret=$(gen_b64 48)
  # TAM 32 BAYT olmalı — CryptoService base64 çözüldüğünde uzunluğu doğrular.
  master_key=$(gen_b64 32)
  pg_password=$(gen_hex 16)
  redis_password=$(gen_hex 16)
  minio_password=$(gen_hex 16)

  # macOS (BSD sed) ve Linux (GNU sed) arasında `-i` bayrağı farklı
  # davranır; taşınabilir olması için geçici dosya + mv kullanılır.
  tmp=$(mktemp)
  sed \
    -e "s|degistir_openssl_rand_base64_48_ciktisi_ile|${access_secret}|" \
    -e "s|degistir_FARKLI_openssl_rand_base64_48_ciktisi_ile|${refresh_secret}|" \
    -e "s|degistir_openssl_rand_base64_32_ciktisi_ile|${master_key}|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pg_password}|" \
    -e "s|^DATABASE_URL=postgresql://incompany:[^@]*@|DATABASE_URL=postgresql://incompany:${pg_password}@|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${redis_password}|" \
    -e "s|^REDIS_URL=redis://:[^@]*@|REDIS_URL=redis://:${redis_password}@|" \
    -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=${minio_password}|" \
    -e "s|^S3_SECRET_KEY=.*|S3_SECRET_KEY=${minio_password}|" \
    .env > "$tmp"
  mv "$tmp" .env

  ok ".env uretildi ve sirlar otomatik dolduruldu"
  printf '    \033[90m(Uretimde bu dosya KULLANILMAZ - bkz. .env.example basindaki not)\033[0m\n'
else
  ok ".env zaten var, dokunulmadi"
fi

# -----------------------------------------------------------------------------
#  3. Bağımlılıklar (workspace kökünden — tüm paketler tek seferde)
# -----------------------------------------------------------------------------
step "Bagimliliklar kuruluyor (npm install)"
npm install --no-audit --no-fund
ok "Bagimliliklar kuruldu"

# -----------------------------------------------------------------------------
#  4. Paylaşılan sözleşme paketi
# -----------------------------------------------------------------------------
step "Paylasilan sozlesme deriliyor (@incompany/contracts)"
npm run build --workspace @incompany/contracts
ok "Sozlesme derlendi"

# -----------------------------------------------------------------------------
#  5. Doğrulama
# -----------------------------------------------------------------------------
step "Kurulum dogrulaniyor (typecheck)"
npm run typecheck
ok "Tip kontrolu temiz"

printf '\n\033[32m=============================================================\033[0m\n'
printf '\033[32m  Kurulum tamamlandi.\033[0m\n'
printf '\033[32m=============================================================\033[0m\n\n'

if [ "${1:-}" = "--demo" ]; then
  printf '\033[36mDemo sunucusu baslatiliyor (Docker gerekmez)...\033[0m\n'
  printf '\033[33mAyri bir terminalde "npm run demo:frontend" calistirmayi unutmayin.\033[0m\n\n'
  npm run demo
else
  cat <<'EOF'
Sonraki adimlar:

  Docker olmadan hizli deneme (gercek kripto/DLP, bellekte depolama):
    npm run demo              # terminal 1
    npm run demo:frontend     # terminal 2

  Tam ortam (PostgreSQL + Redis + MinIO, Docker gerekir):
    npm run docker:up

  http://localhost:5173 adresini acin.
EOF
fi
