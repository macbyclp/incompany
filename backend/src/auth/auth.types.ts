import { GlobalRole } from '@incompany/contracts';

/**
 * JWT erişim token'ının içeriği.
 *
 * TASARIM İLKESİ: token küçük tutulur. Her HTTP isteğinde ve her WebSocket
 * mesajında taşındığı için, buraya konan her alan sürekli ağ maliyeti yaratır.
 * İzin (permission) listesi 20 girişi aşarsa token'a değil Redis'e taşınmalıdır.
 */
export interface JwtAccessPayload {
  /** Subject — kullanıcı kimliği. */
  sub: string;
  /** Organizasyon (tenant) kimliği. Her sorguda kiracı sınırı için kullanılır. */
  org: string;
  /** Oturum kimliği — refresh_sessions.id. İptal bu değerle yapılır. */
  sid: string;
  /**
   * Token sürümü. users.token_version ile eşleşmelidir.
   * Rol değişimi, parola değişimi veya güvenlik olayında artırılır ve
   * o kullanıcının dolaşımdaki TÜM erişim token'ları anında geçersizleşir.
   */
  tv: number;
  roles: GlobalRole[];
  /** Düzleştirilmiş izin anahtarları: ['channel.create', 'audit.read'] */
  perms: string[];
  /** JWT ID — iptal listesi (denylist) anahtarı. */
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

/** Refresh token yükü. Erişim token'ından ayrı bir sır ile imzalanır. */
export interface JwtRefreshPayload {
  sub: string;
  org: string;
  sid: string;
  /** Rotasyon ailesi — token yeniden kullanımı tespitinde tüm aile iptal edilir. */
  fam: string;
  jti: string;
  iat: number;
  exp: number;
}

/**
 * Guard'ların isteğe iliştirdiği doğrulanmış kimlik.
 * Controller'lar `@CurrentUser()` ile bu nesneye erişir.
 */
export interface AuthenticatedUser {
  id: string;
  orgId: string;
  sessionId: string;
  roles: GlobalRole[];
  permissions: ReadonlySet<string>;
  tokenId: string;
  tokenVersion: number;
  expiresAt: number;
}

/** Rol hiyerarşisi. Yüksek değer, düşük değerin tüm yetkilerini kapsar. */
export const ROLE_RANK: Readonly<Record<GlobalRole, number>> = Object.freeze({
  [GlobalRole.ADMIN]: 100,
  [GlobalRole.DEPT_MANAGER]: 50,
  [GlobalRole.EMPLOYEE]: 10,
});

/** Kullanıcının en yüksek rol seviyesi. */
export function highestRank(roles: readonly GlobalRole[]): number {
  return roles.reduce((max, role) => Math.max(max, ROLE_RANK[role] ?? 0), 0);
}

/**
 * Hiyerarşik rol kontrolü.
 * ADMIN, DEPT_MANAGER gerektiren bir uç noktaya erişebilir; tersi geçerli değildir.
 */
export function satisfiesRole(userRoles: readonly GlobalRole[], required: GlobalRole): boolean {
  return highestRank(userRoles) >= (ROLE_RANK[required] ?? Number.POSITIVE_INFINITY);
}

export const TOKEN_TTL = {
  /** Kısa: çalınmış bir erişim token'ının kullanım penceresi bu kadardır. */
  ACCESS_SECONDS: 15 * 60,
  /** Uzun: kullanıcı deneyimi için. Rotasyon + yeniden kullanım tespiti ile korunur. */
  REFRESH_SECONDS: 7 * 24 * 60 * 60,
  /** Saat kayması toleransı — dağıtık düğümlerde NTP kayması olağandır. */
  CLOCK_TOLERANCE_SECONDS: 30,
} as const;
