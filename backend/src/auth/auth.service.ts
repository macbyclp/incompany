import { Injectable, Logger, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { GlobalRole } from '@incompany/contracts';

import { DatabaseService } from '../common/database/database.service';
import { AuditService } from '../audit/audit.service';
import { TokenDenylistService } from './token-denylist.service';
import { UserSecurityCache } from './user-security.cache';
import { verifyPassword } from './password.util';
import {
  TOKEN_TTL,
  type JwtAccessPayload,
  type JwtRefreshPayload,
  type AuthenticatedUser,
} from './auth.types';

/**
 * Kimlik Doğrulama Servisi.
 *
 * REFRESH TOKEN ROTASYONU + YENİDEN KULLANIM TESPİTİ
 *
 *   Her yenilemede eski refresh token iptal edilir ve yenisi verilir.
 *   Aynı "aile" (family) içinde ZATEN KULLANILMIŞ bir token tekrar
 *   sunulursa, bu yalnızca tek bir anlama gelir: token çalınmıştır.
 *
 *   Normal akış:
 *     R1 → (R2 verilir, R1 iptal)  →  R2 → (R3 verilir, R2 iptal)  → ...
 *
 *   Hırsızlık:
 *     Saldırgan R2'yi çalar ve kullanır → R3 alır
 *     Gerçek kullanıcı R2'yi kullanmaya çalışır → R2 ZATEN İPTAL
 *     → TÜM AİLE iptal edilir, her iki taraf da dışarı atılır
 *
 *   Meşru kullanıcının da çıkarılması bilinçlidir: hırsızlığın gerçekleştiği
 *   kesindir ve kullanıcı yeniden giriş yaparak temiz bir aile başlatır.
 *   Alternatif — hiçbir şey yapmamak — saldırganın süresiz erişimi demektir.
 *
 * İKİ GİRİŞ YOLU
 *   Kurumsal dağıtımlarda kimlik doğrulama IdP'de (Azure AD / Okta / ADFS)
 *   yapılmalıdır — MFA, parola politikası ve hesap kilitleme kurumun mevcut
 *   IdP'sinin sorumluluğuna bırakılır, burada yeniden uygulanmaz.
 *
 *   Ancak SSO, kurulumdan HEMEN SONRA henüz yapılandırılmamıştır — ilk
 *   yöneticinin sisteme girebileceği bir yol olmadan SSO'yu kuracak kimse
 *   olmaz (tavuk-yumurta sorunu). Bu yüzden parola tabanlı giriş de
 *   desteklenir: kurulum sihirbazının oluşturduğu ilk yönetici hesabı ve
 *   isteğe bağlı olarak sonradan eklenen "yerel" hesaplar için. `scrypt`
 *   ile karma alınır (bkz. `password.util.ts`) — bcrypt/argon2 gibi native
 *   bağımlılık gerektiren paketler bilinçli olarak tercih edilmedi.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  tokenType: 'Bearer';
}

export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
  deviceLabel?: string;
}

/**
 * Zamanlama saldırısına karşı kukla karma.
 *
 * Kullanıcı bulunamadığında veya `password_hash` NULL olduğunda bile
 * `verifyPassword` ÇALIŞTIRILIR (sonucu atılır). Aksi halde "kullanıcı yok"
 * yanıtı, gerçek scrypt hesaplamasını atladığı için "kullanıcı var ama
 * parola yanlış" yanıtından ölçülebilir biçimde daha hızlı döner — bu fark,
 * bir saldırganın geçerli e-posta adreslerini numaralandırmasına yeter.
 *
 * Değerler rastgele üretilmiştir; hiçbir gerçek parolayla eşleşmesi
 * beklenmez veya gerekmez — yalnızca `scrypt$<32 hex>$<128 hex>` biçimini
 * karşılayıp `verifyPassword`'ün format kontrolünü geçmesi ve gerçek
 * scrypt turunu çalıştırması gerekir.
 */
const DUMMY_HASH_FOR_TIMING =
  'scrypt$2056fd5974ad7ffa79ddef350e4f430a$' +
  '9a96f3736197c6199846dde5f160e1bd5321bf273a99f2a46b2b8922c96cc8a' +
  'b3572c03efd412bc13bee75cc84d2af62d5f1944f2f488c73967e6714e4f41e18';

interface UserAuthRecord {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED';
  token_version: number;
  password_hash: string | null;
  roles: GlobalRole[] | null;
  permissions: string[] | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly issuer: string;
  private readonly audience: string;

  /** ChatGateway tarafından kaydedilir — oturum iptalinde socket'leri kapatır. */
  private sessionRevoker: ((userId: string, reason: string) => Promise<void>) | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly denylist: TokenDenylistService,
    private readonly userCache: UserSecurityCache,
    private readonly audit: AuditService,
  ) {
    this.issuer = this.config.getOrThrow<string>('JWT_ISSUER');
    this.audience = this.config.getOrThrow<string>('JWT_AUDIENCE');
  }

  setSessionRevoker(revoker: (userId: string, reason: string) => Promise<void>): void {
    this.sessionRevoker = revoker;
  }

  // -------------------------------------------------------------------------
  //  Giriş
  // -------------------------------------------------------------------------

  /**
   * IdP doğrulaması tamamlandıktan sonra oturum açar.
   * `idpSubject` OIDC'de `sub`, SAML'de `NameID` claim'idir.
   */
  async loginWithIdp(
    orgId: string,
    idpProvider: string,
    idpSubject: string,
    context: SessionContext,
  ): Promise<TokenPair & { user: { id: string; email: string; displayName: string } }> {
    const user = await this.loadUserByIdp(orgId, idpProvider, idpSubject);

    if (!user) {
      await this.audit.record({
        orgId,
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: idpSubject,
        outcome: 'FAILURE',
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { reason: 'user_not_provisioned', idpProvider },
      });
      // Kullanıcının var olup olmadığını AÇIK ETME — hesap sayımı (enumeration)
      // saldırısına zemin hazırlar.
      throw new UnauthorizedException('Kimlik dogrulama basarisiz');
    }

    if (user.status !== 'ACTIVE') {
      await this.audit.record({
        orgId,
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'DENIED',
        ipAddress: context.ipAddress,
        metadata: { reason: `status_${user.status.toLowerCase()}` },
      });
      throw new ForbiddenException('Hesabiniz aktif degil');
    }

    const tokens = await this.issueTokenPair(user, context, null);

    // RLS (`tenant_isolation_users`) UPDATE için de USING/CHECK uygular —
    // `app.current_org` ayarlanmadan bu satır SESSİZCE 0 satır günceller.
    await this.db.withTenant(orgId, (client) =>
      client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]),
    );

    await this.audit.record({
      orgId,
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      outcome: 'SUCCESS',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { idpProvider },
    });

    return {
      ...tokens,
      user: { id: user.id, email: user.email, displayName: user.display_name },
    };
  }

  /**
   * Parola ile giriş.
   *
   * KİMİN İÇİN? Kurulum sihirbazının oluşturduğu ilk yönetici ve SSO
   * yapılandırılana kadar (veya hiç yapılandırılmayacaksa süresiz) tüm
   * kullanıcılar. `password_hash` sütunu NULL olan bir hesap (yalnızca SSO
   * ile provizyon edilmiş) bu yoldan giriş YAPAMAZ — aşağıdaki kontrol
   * bunu garanti eder.
   *
   * Hesap sayımı (enumeration) saldırısına karşı `loginWithIdp` ile AYNI
   * disiplin uygulanır: kullanıcı yoksa da parola yanlışsa da aynı genel
   * hata mesajı döner, aynı audit action'ı yazılır.
   */
  async loginWithPassword(
    orgSlug: string,
    email: string,
    password: string,
    context: SessionContext,
  ): Promise<TokenPair & { user: { id: string; email: string; displayName: string } }> {
    const org = await this.db.queryMaybe<{ id: string }>(
      'SELECT id FROM organizations WHERE slug = $1 AND is_active = true',
      [orgSlug],
    );

    // Org bulunamasa bile SABİT bir gecikme uygulamak için sahte bir
    // scrypt turu çalıştırılır — aksi halde "org yok" yanıtı "org var ama
    // e-posta yok" yanıtından ÖLÇÜLEBİLİR biçimde daha hızlı döner ve bu,
    // saldırgana geçerli organizasyon slug'larını numaralandırma imkânı verir.
    if (!org) {
      await verifyPassword(password, DUMMY_HASH_FOR_TIMING);
      throw new UnauthorizedException('Kimlik dogrulama basarisiz');
    }

    const user = await this.loadUserByOrgEmail(org.id, email);

    if (!user || !user.password_hash) {
      // `user` yok VEYA yalnızca SSO ile provizyon edilmiş (password_hash
      // NULL). İkisi de aynı genel mesajla reddedilir — hangisi olduğunu
      // açık etmek hesap sayımına zemin hazırlar.
      await verifyPassword(password, DUMMY_HASH_FOR_TIMING);
      await this.audit.record({
        orgId: org.id,
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: email,
        outcome: 'FAILURE',
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { reason: 'invalid_credentials', method: 'password' },
      });
      throw new UnauthorizedException('Kimlik dogrulama basarisiz');
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      await this.audit.record({
        orgId: org.id,
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'FAILURE',
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { reason: 'invalid_credentials', method: 'password' },
      });
      throw new UnauthorizedException('Kimlik dogrulama basarisiz');
    }

    if (user.status !== 'ACTIVE') {
      await this.audit.record({
        orgId: org.id,
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'DENIED',
        ipAddress: context.ipAddress,
        metadata: { reason: `status_${user.status.toLowerCase()}`, method: 'password' },
      });
      throw new ForbiddenException('Hesabiniz aktif degil');
    }

    const tokens = await this.issueTokenPair(user, context, null);

    await this.db.withTenant(org.id, (client) =>
      client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]),
    );

    await this.audit.record({
      orgId: org.id,
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      outcome: 'SUCCESS',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { method: 'password' },
    });

    return {
      ...tokens,
      user: { id: user.id, email: user.email, displayName: user.display_name },
    };
  }

  // -------------------------------------------------------------------------
  //  Token yenileme
  // -------------------------------------------------------------------------

  async refresh(refreshToken: string, context: SessionContext): Promise<TokenPair> {
    let payload: JwtRefreshPayload;

    try {
      payload = await this.jwt.verifyAsync<JwtRefreshPayload>(refreshToken, {
        // Refresh token AYRI bir sır ile imzalanır. Aynı sır kullanılsaydı,
        // bir refresh token erişim token'ı olarak kabul edilebilirdi
        // (tip karıştırma saldırısı).
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        algorithms: ['HS256'],
        issuer: this.issuer,
        clockTolerance: TOKEN_TTL.CLOCK_TOLERANCE_SECONDS,
      });
    } catch {
      throw new UnauthorizedException('Gecersiz yenileme token');
    }

    // Token'ın kendisi saklanmaz, yalnızca SHA-256 özeti. Veritabanı
    // sızarsa kimse bu özetten çalışan bir token üretemez.
    const tokenHash = this.hashToken(refreshToken);

    const session = await this.db.queryMaybe<{
      id: string;
      user_id: string;
      family_id: string;
      revoked_at: Date | null;
      expires_at: Date;
    }>(
      'SELECT id, user_id, family_id, revoked_at, expires_at FROM refresh_sessions WHERE token_hash = $1',
      [tokenHash],
    );

    if (!session) {
      // İmzası geçerli ama veritabanında yok: ya çok eski (temizlenmiş)
      // ya da uydurma. Her iki durumda da reddedilir.
      throw new UnauthorizedException('Gecersiz yenileme token');
    }

    // === YENİDEN KULLANIM TESPİTİ ===
    if (session.revoked_at) {
      await this.handleTokenReuse(session.user_id, session.family_id, payload.org, context);
      throw new UnauthorizedException('Oturum guvenlik nedeniyle sonlandirildi');
    }

    if (session.expires_at <= new Date()) {
      throw new UnauthorizedException('Yenileme token suresi doldu');
    }

    const user = await this.loadUserById(payload.org, session.user_id);
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Hesap aktif degil');
    }

    // Rotasyon TEK TRANSACTION'DA olmalıdır: eski token iptal edilir ve
    // yenisi yazılır. İkisi ayrı ayrı yapılırsa, arada bir hata oluştuğunda
    // ya kullanıcı hiçbir geçerli token'a sahip olmadan kalır ya da iki
    // geçerli token aynı anda dolaşımda olur.
    return this.db.transaction(async (client) => {
      await client.query(
        `UPDATE refresh_sessions SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1`,
        [session.id],
      );
      return this.issueTokenPair(
        user,
        context,
        { familyId: session.family_id, parentId: session.id },
        client,
      );
    });
  }

  /**
   * Token hırsızlığı tespit edildi: aileyi tamamen iptal et.
   *
   * Bu, sistemdeki en yüksek öncelikli güvenlik olaylarından biridir ve
   * SIEM'de kural tetiklemelidir.
   */
  private async handleTokenReuse(
    userId: string,
    familyId: string,
    orgId: string,
    context: SessionContext,
  ): Promise<void> {
    this.logger.error({ userId, familyId, ip: context.ipAddress }, 'REFRESH TOKEN YENIDEN KULLANIMI — olasi hirsizlik');

    await this.db.query(
      `UPDATE refresh_sessions
          SET revoked_at = now(), revoked_reason = 'reuse_detected'
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );

    // Erişim token'larını da geçersiz kıl — refresh iptali tek başına
    // saldırganın elindeki 15 dakikalık erişim token'ını durdurmaz.
    await this.userCache.bumpTokenVersion(orgId, userId);
    await this.sessionRevoker?.(userId, 'TOKEN_REUSE_DETECTED');

    await this.audit.record({
      orgId,
      actorId: userId,
      action: 'auth.token_reuse_detected',
      resourceType: 'session',
      resourceId: familyId,
      outcome: 'DENIED',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { severity: 'critical' },
    });
  }

  // -------------------------------------------------------------------------
  //  Çıkış
  // -------------------------------------------------------------------------

  /** Tek oturumu sonlandırır (bu cihazdan çıkış). */
  async logout(user: AuthenticatedUser, refreshToken?: string): Promise<void> {
    await this.denylist.revoke(user.tokenId, user.expiresAt, 'logout');

    if (refreshToken) {
      await this.db.query(
        `UPDATE refresh_sessions SET revoked_at = now(), revoked_reason = 'logout'
          WHERE token_hash = $1 AND revoked_at IS NULL`,
        [this.hashToken(refreshToken)],
      );
    }

    await this.audit.record({
      orgId: user.orgId,
      actorId: user.id,
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: user.sessionId,
      outcome: 'SUCCESS',
    });
  }

  /**
   * Tüm cihazlardan çıkış.
   * `token_version` artırımı, dolaşımdaki her erişim token'ını anında
   * geçersiz kılar — denylist'e tek tek eklemeye gerek kalmaz.
   */
  async logoutAll(userId: string, orgId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_sessions SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );

    await this.userCache.bumpTokenVersion(orgId, userId);
    await this.sessionRevoker?.(userId, reason);

    await this.audit.record({
      orgId,
      actorId: userId,
      action: 'auth.logout_all',
      resourceType: 'user',
      resourceId: userId,
      outcome: 'SUCCESS',
      metadata: { reason },
    });
  }

  /** Kullanıcının etkin oturumları — "cihazlarım" ekranı için. */
  async listSessions(userId: string): Promise<Array<{
    id: string;
    deviceLabel: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
    expiresAt: Date;
  }>> {
    const rows = await this.db.query<{
      id: string;
      device_label: string | null;
      ip_address: string | null;
      user_agent: string | null;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, device_label, ip_address, user_agent, created_at, expires_at
         FROM refresh_sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [userId],
    );

    return rows.map((r) => ({
      id: r.id,
      deviceLabel: r.device_label,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }

  /** Süresi dolmuş oturum kayıtlarını temizler — günlük planlı görev. */
  async pruneExpiredSessions(): Promise<number> {
    const rows = await this.db.query(
      // 30 gün bekleme: yeniden kullanım tespitinin çalışabilmesi için iptal
      // edilmiş kayıtlar bir süre durmalıdır. Hemen silmek, çalınmış bir
      // token'ın "bilinmeyen" olarak reddedilmesine yol açar — bu da
      // geçerli bir ret, ama hırsızlık sinyalini kaybettirir.
      `DELETE FROM refresh_sessions
        WHERE expires_at < now() - interval '30 days'
        RETURNING id`,
    );
    return rows.length;
  }

  // -------------------------------------------------------------------------
  //  Token üretimi
  // -------------------------------------------------------------------------

  /**
   * @param executor Transaction içindeyse o transaction'ın client'ı; aksi
   *                 halde havuz kullanılır. Rotasyon sırasında bu ZORUNLUDUR —
   *                 eski token'ın iptali ile yenisinin yazımı atomik olmalıdır.
   */
  private async issueTokenPair(
    user: UserAuthRecord,
    context: SessionContext,
    rotation: { familyId: string; parentId: string } | null,
    executor?: PoolClient,
  ): Promise<TokenPair> {
    const now = Math.floor(Date.now() / 1000);
    const sessionId = randomUUID();
    const familyId = rotation?.familyId ?? randomUUID();

    const accessJti = randomUUID();
    const refreshJti = randomUUID();

    const accessExp = now + TOKEN_TTL.ACCESS_SECONDS;
    const refreshExp = now + TOKEN_TTL.REFRESH_SECONDS;

    const accessPayload: JwtAccessPayload = {
      sub: user.id,
      org: user.org_id,
      sid: sessionId,
      tv: user.token_version,
      roles: user.roles ?? [GlobalRole.EMPLOYEE],
      perms: user.permissions ?? [],
      jti: accessJti,
      iat: now,
      exp: accessExp,
      iss: this.issuer,
      aud: this.audience,
    };

    const refreshPayload: JwtRefreshPayload = {
      sub: user.id,
      org: user.org_id,
      sid: sessionId,
      fam: familyId,
      jti: refreshJti,
      iat: now,
      exp: refreshExp,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        algorithm: 'HS256',
      }),
      this.jwt.signAsync(refreshPayload, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        algorithm: 'HS256',
      }),
    ]);

    const insertSql = `
      INSERT INTO refresh_sessions (
        id, user_id, token_hash, family_id, parent_id,
        user_agent, ip_address, device_label, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9))`;

    const insertParams = [
      sessionId,
      user.id,
      this.hashToken(refreshToken),
      familyId,
      rotation?.parentId ?? null,
      context.userAgent?.slice(0, 500) ?? null,
      context.ipAddress ?? null,
      context.deviceLabel?.slice(0, 100) ?? null,
      refreshExp,
    ];

    if (executor) {
      await executor.query(insertSql, insertParams);
    } else {
      await this.db.query(insertSql, insertParams);
    }

    return {
      accessToken,
      refreshToken,
      accessExpiresAt: accessExp * 1000,
      refreshExpiresAt: refreshExp * 1000,
      tokenType: 'Bearer',
    };
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  /**
   * SHA-256 — bcrypt/Argon2 DEĞİL.
   *
   * Refresh token'lar 256 bit rastgeleliğe sahiptir; kaba kuvvetle
   * tahmin edilemezler. Yavaş hash fonksiyonunun tek amacı düşük entropili
   * parolaları korumaktır ve burada yalnızca her yenilemeye 100 ms ekler.
   */
  private hashToken(token: string): Buffer {
    return createHash('sha256').update(token).digest();
  }

  /**
   * `users` tablosu `tenant_isolation_users` RLS politikasıyla korunur
   * (`USING (org_id = current_setting('app.current_org', true)::uuid)`).
   * `WITH CHECK` ayrı tanımlanmadığından bu ifade SELECT için de geçerlidir:
   * `app.current_org` ayarlanmadan sorgu hatasız ama SESSİZCE sıfır satır
   * döner — bu üç yükleyici bu yüzden `withTenant` kullanır, düz `query`
   * DEĞİL. Gerçek bir PostgreSQL'e karşı ilk kez çalıştırıldığında (bu
   * commit öncesi) bu sessiz filtreleme "gecerli kullanicinin girisi
   * calismiyor" şeklinde ortaya çıktı — hata fırlatmadığı için fark
   * edilmesi diğer RLS bloklarından daha zordu.
   */
  private async loadUserByOrgEmail(orgId: string, email: string): Promise<UserAuthRecord | null> {
    return this.db.withTenant(orgId, async (client) => {
      const result = await client.query<UserAuthRecord>(
        `${USER_AUTH_QUERY}
          WHERE u.org_id = $1 AND u.email = $2 AND u.deleted_at IS NULL
          GROUP BY u.id`,
        [orgId, email],
      );
      return result.rows[0] ?? null;
    });
  }

  private async loadUserByIdp(
    orgId: string,
    provider: string,
    subject: string,
  ): Promise<UserAuthRecord | null> {
    return this.db.withTenant(orgId, async (client) => {
      const result = await client.query<UserAuthRecord>(
        `${USER_AUTH_QUERY}
          WHERE u.org_id = $1 AND u.idp_provider = $2 AND u.idp_subject = $3
            AND u.deleted_at IS NULL
          GROUP BY u.id`,
        [orgId, provider, subject],
      );
      return result.rows[0] ?? null;
    });
  }

  private async loadUserById(orgId: string, userId: string): Promise<UserAuthRecord | null> {
    return this.db.withTenant(orgId, async (client) => {
      const result = await client.query<UserAuthRecord>(
        `${USER_AUTH_QUERY} WHERE u.id = $1 AND u.deleted_at IS NULL GROUP BY u.id`,
        [userId],
      );
      return result.rows[0] ?? null;
    });
  }
}

/**
 * Kullanıcı + rolleri + izinleri tek sorguda.
 *
 * `array_agg(DISTINCT ...) FILTER (WHERE ...)` kullanılır: rolü olmayan bir
 * kullanıcıda `array_agg` `{NULL}` döndürür ve kod bunu geçerli bir rol
 * sanır. FILTER bunu engeller ve NULL döner.
 *
 * Süresi dolmuş rol atamaları (`expires_at`) dışlanır — geçici yükseltmeler
 * kendiliğinden sona ermelidir.
 */
// `roles.key` ve `role_permissions.permission_key` `citext` tipindedir
// (büyük/küçük harf duyarsız karşılaştırma için — bkz. 001_schema.sql).
// `citext[]`'in OID'si `node-postgres`'in yerleşik tip ayrıştırıcısında
// KAYITLI DEĞİLDİR: `::text[]` cast'i olmadan sürücü bu sütunu ayrıştırılmış
// bir JS dizisi değil, PostgreSQL'in ham '{ADMIN}' metin gösterimini
// döndürür. Bu, gerçek bir PostgreSQL'e karşı ilk kez çalıştırıldığında
// (giriş başarılı ama JWT'deki `roles` bir dizi değil ham dize olduğu için
// her sonraki istek "Token yapisi bozuk" ile reddedildi) ortaya çıktı.
const USER_AUTH_QUERY = `
  SELECT u.id, u.org_id, u.email, u.display_name, u.status, u.token_version, u.password_hash,
         array_agg(DISTINCT r.key::text) FILTER (WHERE r.key IS NOT NULL) AS roles,
         array_agg(DISTINCT rp.permission_key::text) FILTER (WHERE rp.permission_key IS NOT NULL) AS permissions
    FROM users u
    LEFT JOIN user_roles ur
           ON ur.user_id = u.id
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
    LEFT JOIN roles r ON r.id = ur.role_id
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
`;
