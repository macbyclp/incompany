import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import { DatabaseService } from '../../common/database/database.service';
import { RedisService } from '../../common/redis/redis.service';
import { AuditService } from '../../audit/audit.service';

/**
 * Kurumsal Kimlik Sağlayıcı Entegrasyonu (SSO).
 *
 * DESTEKLENEN AKIŞ: OpenID Connect — Authorization Code + PKCE.
 *
 * NEDEN OIDC, SAML DEĞİL (mümkünse)?
 *   SAML, XML imza doğrulaması gerektirir ve bu tarihsel olarak güvenlik
 *   açığı üretmeye en yatkın alanlardan biridir (XML Signature Wrapping,
 *   XXE, canonicalization farklılıkları). OIDC, JWT tabanlıdır ve doğrulama
 *   yüzeyi çok daha dardır. Kurum SAML dayatıyorsa, DOĞRULAMAYI KENDİNİZ
 *   YAZMAYIN — denetlenmiş bir kütüphane kullanın (`@node-saml/node-saml`).
 *
 * NEDEN PKCE?
 *   Authorization code, tarayıcı yönlendirmesiyle taşınır ve loglara,
 *   Referer başlığına veya tarayıcı geçmişine düşebilir. PKCE, kodun tek
 *   başına işe yaramamasını sağlar: token değişimi için `code_verifier` de
 *   gerekir ve o hiçbir zaman URL'de görünmez.
 *
 * PROVİZYON MODELİ
 *   JIT (Just-In-Time) provizyon BİLİNÇLİ OLARAK KAPALIDIR. IdP'de kimliği
 *   doğrulanan herkesin otomatik hesap alması, dizinde bulunan ama bu
 *   sisteme erişmemesi gereken kişilere (yükleniciler, servis hesapları)
 *   erişim verir. Provizyon SCIM üzerinden, açık bir karar olarak yapılır.
 */

interface AuthorizationState {
  orgId: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  returnTo: string;
  createdAt: number;
}

interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

/** State ve nonce ömrü — kullanıcının IdP'de giriş yapması için makul süre. */
const STATE_TTL_SECONDS = 600;

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  //  1. Yetkilendirme isteği
  // -------------------------------------------------------------------------

  /**
   * IdP'ye yönlendirme URL'sini üretir.
   *
   * Üç güvenlik parametresi üretilir:
   *   · `state`         — CSRF koruması. Geri dönen istek bizim başlattığımız mı?
   *   · `nonce`         — token yeniden oynatma (replay) koruması
   *   · `code_verifier` — PKCE; kodun tek başına yetmemesini sağlar
   */
  async buildAuthorizationUrl(
    orgSlug: string,
    returnTo: string,
  ): Promise<{ url: string; state: string }> {
    const org = await this.loadOrgConfig(orgSlug);

    // 32 bayt = 256 bit entropi. Tahmin edilemez olmalıdır.
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(64).toString('base64url');

    // PKCE S256: doğrulayıcının SHA-256 özeti IdP'ye gönderilir,
    // doğrulayıcının kendisi yalnızca bizde kalır.
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const redirectUri = `${this.config.getOrThrow<string>('PUBLIC_URL')}/api/v1/auth/sso/callback`;

    await this.redis.setex(
      this.stateKey(state),
      STATE_TTL_SECONDS,
      JSON.stringify({
        orgId: org.orgId,
        codeVerifier,
        nonce,
        redirectUri,
        // Açık yönlendirme (open redirect) koruması: yalnızca kendi
        // uygulamamız içindeki yollara dönülebilir.
        returnTo: this.sanitizeReturnTo(returnTo),
        createdAt: Date.now(),
      } satisfies AuthorizationState),
    );

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: org.config.clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return { url: `${org.config.authorizationEndpoint}?${params.toString()}`, state };
  }

  // -------------------------------------------------------------------------
  //  2. Geri dönüş (callback)
  // -------------------------------------------------------------------------

  /**
   * IdP'den dönen kodu doğrular ve kimlik bilgilerini çıkarır.
   *
   * @returns Doğrulanmış IdP kimliği. Oturum açma AuthService'in işidir —
   *          bu servis yalnızca "bu kişi gerçekten kim?" sorusunu yanıtlar.
   */
  async handleCallback(
    code: string,
    state: string,
  ): Promise<{ orgId: string; idpProvider: string; idpSubject: string; email: string; returnTo: string }> {
    // State, TEK KULLANIMLIK olmalıdır: `getdel` atomik okur ve siler.
    // Sadece okuyup sonra silmek, yarış koşulunda aynı state'in iki kez
    // kullanılmasına izin verir.
    const raw = await this.redis.raw.getdel(this.stateKey(state));
    if (!raw) {
      // Süresi dolmuş, hiç var olmamış veya zaten kullanılmış.
      //
      // Bu durum meşru olarak da oluşabilir (kullanıcı giriş sayfasını
      // 10 dakikadan uzun açık bıraktı), ama bir CSRF veya state yeniden
      // oynatma denemesinin de tek görünür izidir. Denetime yazılır ki
      // yoğunlaşması fark edilebilsin.
      await this.audit.record({
        orgId: '00000000-0000-0000-0000-000000000000',
        action: 'auth.sso_invalid_state',
        resourceType: 'sso',
        outcome: 'DENIED',
        metadata: { reason: 'state_missing_or_reused' },
      });
      throw new UnauthorizedException('Gecersiz veya suresi dolmus oturum acma istegi');
    }

    const stored = JSON.parse(raw) as AuthorizationState;
    const org = await this.loadOrgConfigById(stored.orgId);

    // --- Token değişimi ---
    const tokenResponse = await this.exchangeCode(org.config, code, stored);

    // --- ID token doğrulaması ---
    let claims: { sub: string; email?: string; email_verified?: boolean; nonce?: string };
    try {
      claims = await this.verifyIdToken(org.config, tokenResponse.id_token, stored.nonce);
    } catch (error) {
      // ID token doğrulamasının başarısız olması NORMAL DEĞİLDİR: token
      // IdP'den yeni alınmıştır. Başarısızlık ya yanlış yapılandırma
      // ya da aktif bir saldırı anlamına gelir.
      await this.audit.record({
        orgId: stored.orgId,
        action: 'auth.sso_token_invalid',
        resourceType: 'sso',
        outcome: 'FAILURE',
        metadata: { provider: org.provider, severity: 'high' },
      });
      throw error;
    }

    if (!claims.sub) {
      throw new UnauthorizedException('ID token `sub` claim icermiyor');
    }
    // E-posta doğrulanmamışsa GÜVENİLMEZ. Bazı IdP'lerde kullanıcı
    // kendi e-postasını değiştirebilir; doğrulanmamış bir e-posta ile
    // hesap eşleştirmek, hesap devralmaya yol açar.
    if (claims.email && claims.email_verified === false) {
      this.logger.warn({ sub: claims.sub }, 'Dogrulanmamis e-posta ile SSO denemesi');
    }

    return {
      orgId: stored.orgId,
      idpProvider: org.provider,
      idpSubject: claims.sub,
      email: claims.email ?? '',
      returnTo: stored.returnTo,
    };
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  private async exchangeCode(
    config: OidcConfig,
    code: string,
    stored: AuthorizationState,
  ): Promise<{ id_token: string; access_token: string }> {
    const response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: stored.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: stored.codeVerifier,
      }),
      // IdP yanıt vermezse istek sonsuza kadar asılı kalmasın.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        { status: response.status, body: body.slice(0, 200) },
        'IdP token degisimi basarisiz',
      );
      throw new UnauthorizedException('Kimlik saglayici dogrulamasi basarisiz');
    }

    const tokens = (await response.json()) as { id_token?: string; access_token?: string };
    if (!tokens.id_token) {
      throw new UnauthorizedException('IdP id_token dondurmedi');
    }

    return tokens as { id_token: string; access_token: string };
  }

  /**
   * ID token doğrulaması.
   *
   * ÜRETİMDE `jose` KÜTÜPHANESİ KULLANILMALIDIR:
   *
   *   import { createRemoteJWKSet, jwtVerify } from 'jose';
   *   const jwks = createRemoteJWKSet(new URL(config.jwksUri));
   *   const { payload } = await jwtVerify(idToken, jwks, {
   *     issuer: config.issuer,
   *     audience: config.clientId,
   *     clockTolerance: 30,
   *   });
   *
   * `createRemoteJWKSet` anahtar önbelleğini ve rotasyonunu kendisi yönetir.
   * JWKS'i elle çekip önbelleklemek, IdP anahtar döndürdüğünde tüm
   * girişlerin kırılmasına yol açan klasik bir hatadır.
   *
   * DOĞRULANMASI ZORUNLU CLAIM'LER — biri atlanırsa doğrulama işe yaramaz:
   *   iss   → token gerçekten bu IdP'den mi?
   *   aud   → bize mi verilmiş, başka bir uygulamaya mı?
   *   exp   → süresi dolmuş mu?
   *   nonce → bizim başlattığımız akışa mı ait? (replay koruması)
   */
  private async verifyIdToken(
    config: OidcConfig,
    idToken: string,
    expectedNonce: string,
  ): Promise<{ sub: string; email?: string; email_verified?: boolean; nonce?: string }> {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');

    const jwks = createRemoteJWKSet(new URL(config.jwksUri));

    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(idToken, jwks, {
        issuer: config.issuer,
        audience: config.clientId,
        clockTolerance: 30,
      });
      payload = result.payload as Record<string, unknown>;
    } catch (error) {
      this.logger.error({ err: (error as Error).message }, 'ID token dogrulamasi basarisiz');
      throw new UnauthorizedException('Kimlik dogrulama basarisiz');
    }

    // Nonce karşılaştırması sabit zamanlıdır. Bu değer bir sır olmasa da,
    // kriptografik karşılaştırmalarda `===` kullanmamak iyi bir alışkanlıktır.
    const receivedNonce = String(payload.nonce ?? '');
    if (!this.safeCompare(receivedNonce, expectedNonce)) {
      this.logger.error({ sub: payload.sub }, 'Nonce uyusmazligi — olasi replay saldirisi');
      throw new UnauthorizedException('Kimlik dogrulama basarisiz');
    }

    return payload as { sub: string; email?: string; email_verified?: boolean; nonce?: string };
  }

  /**
   * Açık yönlendirme (open redirect) koruması.
   *
   * `?returnTo=https://saldirgan.com` ile gelen bir istek, kullanıcıyı
   * başarılı girişten sonra saldırganın sitesine gönderir — üstelik
   * kurumsal giriş akışının güvenilirliğiyle. Yalnızca kendi uygulamamız
   * içindeki göreli yollara izin verilir.
   */
  private sanitizeReturnTo(returnTo: string): string {
    if (!returnTo || typeof returnTo !== 'string') return '/';
    // Protokol-göreli (`//evil.com`) ve mutlak URL'leri reddet.
    if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return '/';
    // Ters eğik çizgi bazı tarayıcılarda `/` gibi yorumlanır (`/\evil.com`).
    if (returnTo.includes('\\')) return '/';
    return returnTo.slice(0, 500);
  }

  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.byteLength !== bufB.byteLength) return false;
    return timingSafeEqual(bufA, bufB);
  }

  private async loadOrgConfig(slug: string): Promise<{ orgId: string; provider: string; config: OidcConfig }> {
    const row = await this.db.queryMaybe<{ id: string; sso_config: Record<string, unknown> }>(
      'SELECT id, sso_config FROM organizations WHERE slug = $1 AND is_active = true',
      [slug],
    );
    if (!row) throw new BadRequestException('Organizasyon bulunamadi');
    return this.parseConfig(row.id, row.sso_config);
  }

  private async loadOrgConfigById(orgId: string): Promise<{ orgId: string; provider: string; config: OidcConfig }> {
    const row = await this.db.queryOne<{ id: string; sso_config: Record<string, unknown> }>(
      'SELECT id, sso_config FROM organizations WHERE id = $1 AND is_active = true',
      [orgId],
      'Organizasyon bulunamadi',
    );
    return this.parseConfig(row.id, row.sso_config);
  }

  private parseConfig(
    orgId: string,
    ssoConfig: Record<string, unknown>,
  ): { orgId: string; provider: string; config: OidcConfig } {
    const required = ['issuer', 'clientId', 'authorizationEndpoint', 'tokenEndpoint', 'jwksUri'];
    const missing = required.filter((key) => !ssoConfig[key]);

    if (missing.length > 0) {
      this.logger.error({ orgId, missing }, 'SSO yapilandirmasi eksik');
      throw new BadRequestException('SSO bu organizasyon icin yapilandirilmamis');
    }

    return {
      orgId,
      provider: String(ssoConfig.provider ?? 'oidc'),
      config: {
        issuer: String(ssoConfig.issuer),
        clientId: String(ssoConfig.clientId),
        // İstemci sırrı veritabanında DEĞİL, sır yöneticisindedir.
        // sso_config yalnızca hangi sırrın kullanılacağının adını taşır.
        clientSecret: this.config.getOrThrow<string>(`SSO_CLIENT_SECRET_${orgId.slice(0, 8)}`),
        authorizationEndpoint: String(ssoConfig.authorizationEndpoint),
        tokenEndpoint: String(ssoConfig.tokenEndpoint),
        jwksUri: String(ssoConfig.jwksUri),
      },
    };
  }

  private stateKey(state: string): string {
    return `sso:state:${state}`;
  }
}
