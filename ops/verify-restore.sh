#!/usr/bin/env bash
# Bir veritabanı dökümünün gerçekten geri yüklenebildiğini canlı veritabanına dokunmadan dener:
# döküm geçici bir veritabanına yüklenir, ana tabloların satır sayıları yazılır, geçici veritabanı silinir.
# Düzenli (ör. haftalık) çalıştırmak için uygundur: geri yüklenemeyen yedek yedek değildir.
# Kullanım: ops/verify-restore.sh <db-....dump>
set -euo pipefail

DUMP="${1:?kullanım: ops/verify-restore.sh <db.dump>}"
[ -s "$DUMP" ] || { echo "Döküm bulunamadı ya da boş" >&2; exit 1; }
TMPDB="incompany_verify_$$"
PSQL=(docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1)

cleanup() { "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $TMPDB WITH (FORCE)" > /dev/null 2>&1 || true; }
trap cleanup EXIT

"${PSQL[@]}" -d postgres -c "CREATE DATABASE $TMPDB" > /dev/null
docker compose exec -T db pg_restore -U postgres -d "$TMPDB" --no-owner --exit-on-error < "$DUMP"

echo "Geri yüklenen veritabanındaki satır sayıları:"
"${PSQL[@]}" -d "$TMPDB" -At -F ' : ' -c "
  SELECT 'kullanıcı', count(*) FROM users UNION ALL
  SELECT 'hesap', count(*) FROM accounts UNION ALL
  SELECT 'konuşma', count(*) FROM conversations UNION ALL
  SELECT 'mesaj', count(*) FROM messages UNION ALL
  SELECT 'rıza kaydı', count(*) FROM consent_log UNION ALL
  SELECT 'şema sürümü', max(version) FROM schema_migrations"
echo "Geri yükleme denemesi başarılı."
