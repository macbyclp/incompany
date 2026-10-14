#!/usr/bin/env bash
# Yedekten geri yükleme. Mevcut veritabanının ve veri klasörünün ÜZERİNE YAZAR.
# Kullanım: ops/restore.sh <db-....dump> <data-....tgz>
# Geri yüklerken yedeğin alındığı sistemdeki APP_SECRET (.env) kullanılmalı; aksi halde bağlayıcı sırları okunamaz.
set -euo pipefail

DUMP="${1:?kullanım: ops/restore.sh <db.dump> <data.tgz>}"
DATA="${2:?kullanım: ops/restore.sh <db.dump> <data.tgz>}"
[ -s "$DUMP" ] && [ -s "$DATA" ] || { echo "Yedek dosyaları bulunamadı ya da boş" >&2; exit 1; }
DATA_ABS="$(cd "$(dirname "$DATA")" && pwd)/$(basename "$DATA")"

read -r -p "Mevcut veritabanı ve veri SİLİNİP yedekle değiştirilecek. Devam için 'evet' yaz: " ans
[ "$ans" = "evet" ] || { echo "Vazgeçildi"; exit 1; }

docker compose stop app
docker compose up -d db
until docker compose exec -T db pg_isready -U postgres -d postgres > /dev/null 2>&1; do sleep 1; done

echo "→ Veritabanı yeniden kuruluyor"
docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS incompany WITH (FORCE)" -c "CREATE DATABASE incompany"
docker compose exec -T db pg_restore -U postgres -d incompany --no-owner --exit-on-error < "$DUMP"

echo "→ Uygulama verisi geri açılıyor"
docker compose run --rm --no-deps -T -v "$DATA_ABS:/backup/data.tgz:ro" --entrypoint sh app \
  -c "find /data -mindepth 1 -delete && tar -C /data -xzf /backup/data.tgz"

docker compose up -d app
echo "Tamam. Sağlık: curl -s http://127.0.0.1:3000/health"
