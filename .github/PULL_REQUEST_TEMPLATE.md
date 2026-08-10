## Ne değişti

## Neden

## Nasıl test edildi

- [ ] `npm run typecheck` temiz
- [ ] `npm test` geçiyor
- [ ] `npm run build` başarılı
- [ ] Demo modunda elle test edildi (`npm run demo`)

## Güvenlik kritik mi?

Bu PR aşağıdakilerden birine dokunuyorsa işaretleyin — bu PR'lar ek inceleme alır:

- [ ] `common/crypto/**` (şifreleme, anahtar yönetimi)
- [ ] `auth/**` (kimlik doğrulama, JWT, oturum)
- [ ] `dlp/**` (veri sızıntısı önleme)
- [ ] `chat/sanitize.ts` (XSS / girdi temizleme)
- [ ] `db/postgres/001_schema.sql` (RLS, denetim zinciri)
- [ ] Hiçbiri
