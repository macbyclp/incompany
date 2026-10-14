#!/usr/bin/env bash
# incompany yedeği: Postgres dökümü + uygulama veri klasörü (WhatsApp oturumları).
# Kullanım: ops/backup.sh [hedef-klasör]      (docker-compose.yml'in bulunduğu klasörden çalıştır)
#
# UYARI: APP_SECRET bu yedeğe GİRMEZ ve girmemelidir. Bağlayıcı sırları (bot anahtarları, IMAP parolaları)
# veritabanında APP_SECRET ile şifreli durur; geri yüklerken aynı APP_SECRET gerekir. .env dosyanı ayrıca,
# başka bir güvenli yerde sakla.
set -euo pipefail

OUT="${1:-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
OUT_ABS="$(cd "$OUT" && pwd)"

echo "→ Veritabanı dökülüyor"
docker compose exec -T db pg_dump -U postgres -Fc incompany > "$OUT_ABS/db-$STAMP.dump"

echo "→ Uygulama verisi (oturum klasörleri) arşivleniyor"
docker compose run --rm --no-deps -T -v "$OUT_ABS:/backup" --entrypoint sh app \
  -c "tar -C /data -czf /backup/data-$STAMP.tgz ."

# Boş ya da bozuk yedeği yedek sanmamak için hemen doğrula.
test -s "$OUT_ABS/db-$STAMP.dump" || { echo "HATA: veritabanı dökümü boş" >&2; exit 1; }
docker compose exec -T db pg_restore --list < "$OUT_ABS/db-$STAMP.dump" > /dev/null
tar -tzf "$OUT_ABS/data-$STAMP.tgz" > /dev/null

echo "Tamam:"
ls -lh "$OUT_ABS/db-$STAMP.dump" "$OUT_ABS/data-$STAMP.tgz"
echo "Geri yüklenebildiğini ayrıca denemek için: ops/verify-restore.sh $OUT_ABS/db-$STAMP.dump"
