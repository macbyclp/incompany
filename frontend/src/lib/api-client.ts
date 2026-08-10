import { authStore } from '../store/auth.store';

/**
 * Kimlik Doğrulamalı Fetch Yardımcısı.
 *
 * NEDEN GEREKLİ?
 *   `JwtAuthGuard` (backend), yalnızca `Authorization: Bearer <token>`
 *   başlığını okur — `credentials: 'include'` ile giden çerez, erişim
 *   token'ını TAŞIMAZ (o yalnızca `/auth/refresh` çağrısının kullandığı
 *   httpOnly refresh çerezidir, bkz. auth.store.ts). Bu başlık eksikse
 *   korumalı her uç nokta 401 döner.
 *
 *   Bu sınıf hata, bu yardımcı yazılmadan önce ~20 ayrı `fetch()` çağrısında
 *   tekrarlanmıştı ve gerçek bir PostgreSQL + JWT backend'ine karşı ilk kez
 *   çalıştırıldığında ortaya çıktı (demo modu farklı, sahte bir kimlik
 *   doğrulama yolu kullandığı için bu hiç görünmemişti).
 *
 * Tek bir yerde durur: gelecekte token yenileme/otomatik-retry gibi bir
 * davranış eklenmek istenirse, tek dosya değişir.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = authStore.getState().accessToken;

  const headers = new Headers(init.headers);
  if (accessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  return fetch(input, {
    ...init,
    credentials: 'include',
    headers,
  });
}
