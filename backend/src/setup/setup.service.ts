import { Injectable, Logger, ConflictException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../common/database/database.service';
import { AuditService } from '../audit/audit.service';
import { AuthService, type SessionContext } from '../auth/auth.service';
import { hashPassword, validatePasswordStrength } from '../auth/password.util';

/**
 * Kurulum Sihirbazı — İlk Çalıştırma Deneyimi.
 *
 * NEDEN GEREKLİ?
 *   Bu sistem SSO ile kimlik doğrular. Ama SSO'yu YAPILANDIRACAK ilk
 *   yöneticinin, SSO henüz yokken sisteme girebilmesi gerekir — klasik
 *   tavuk-yumurta sorunu. Nextcloud, GitLab, Mattermost gibi tüm kendi
 *   sunucunda barındırılan (self-hosted) ürünler bu yüzden bir "ilk kurulum"
 *   akışına sahiptir: boş bir veritabanına ilk kez bağlanan kişi, kurumun
 *   organizasyonunu ve ilk yönetici hesabını oluşturur.
 *
 * TEK SEFERLİK KAPI
 *   `organizations` tablosunda EN AZ BİR satır varsa bu uç nokta kalıcı
 *   olarak kilitlenir. Aksi halde, kurulum tamamlandıktan yıllar sonra
 *   birinin bu uç noktayı bulup ikinci bir "ilk yönetici" oluşturarak
 *   sisteme sızması mümkün olurdu — bu, kimlik doğrulamayı tamamen
 *   atlatan bir arka kapı demektir.
 *
 * YARIŞ KORUMASI
 *   İki kişi (veya bir betik iki kez) aynı anda `/setup/bootstrap`'i
 *   çağırırsa, ikisi de "organizasyon yok" kontrolünü geçip iki ayrı
 *   organizasyon oluşturabilir. BLOKLAYAN bir advisory lock
 *   (`pg_advisory_xact_lock`) bunu engeller — planlı görevlerdeki
 *   `pg_try_advisory_xact_lock`'tan farklı olarak burada ikinci isteğin
 *   sessizce atlanması DEĞİL, ilkinin bitmesini bekleyip "zaten kurulmuş"
 *   yanıtı alması istenir.
 */

/** Advisory lock anahtarı — bu değeri kullanan başka bir görev olmamalı. */
const SETUP_LOCK_KEY = 4_020_001;

export interface BootstrapInput {
  organizationName: string;
  adminDisplayName: string;
  adminEmail: string;
  adminPassword: string;
}

@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Kurulum gerekiyor mu?
   *
   * Frontend bunu uygulama açılışında sorar: `true` ise kurulum
   * sihirbazı gösterilir, `false` ise normal giriş ekranı.
   */
  async needsSetup(): Promise<boolean> {
    const row = await this.db.queryMaybe<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM organizations) AS exists',
    );
    return !row?.exists;
  }

  /**
   * İlk organizasyonu ve yönetici hesabını oluşturur, oturum açar.
   *
   * @returns Yeni yöneticinin token çifti — sihirbaz tamamlanır tamamlanmaz
   *          kullanıcı elle giriş yapmadan uygulamaya düşer.
   */
  async bootstrap(input: BootstrapInput, context: SessionContext) {
    const passwordError = validatePasswordStrength(input.adminPassword);
    if (passwordError) throw new BadRequestException(passwordError);

    const orgName = input.organizationName.trim();
    if (orgName.length < 2) {
      throw new BadRequestException('Organizasyon adi en az 2 karakter olmali');
    }
    // İstemci tarafı doğrulamasıyla AYNI kural (bkz. SetupWizard.tsx) —
    // istemci kontrolüne asla tek başına güvenilmez. Ad doğrudan URL
    // slug'ına dönüşür (bkz. uniqueSlug); boşluk/rakam serbest bırakılırsa
    // slug üretimi öngörülemez hale gelir.
    if (/\s|\d/u.test(orgName)) {
      throw new BadRequestException('Organizasyon adi bosluk veya rakam iceremez');
    }

    const displayName = input.adminDisplayName.trim();
    if (displayName.length < 2) {
      throw new BadRequestException('Ad soyad en az 2 karakter olmali');
    }

    // Parola karması, transaction'a girmeden ÖNCE hesaplanır: scrypt bir
    // CPU işlemidir (I/O değil), veritabanı bağlantısını ve transaction
    // süresini gereksiz yere uzatmamalıdır.
    const passwordHash = await hashPassword(input.adminPassword);

    const result = await this.db.transaction(async (client) => {
      // BLOKLAYAN kilit: eşzamanlı ikinci bir istek burada bekler, boş
      // döndürülmez. Kilit bu transaction bitene kadar tutulur ve
      // transaction sonunda otomatik bırakılır.
      await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK_KEY]);

      const existing = await client.query('SELECT 1 FROM organizations LIMIT 1');
      if ((existing.rowCount ?? 0) > 0) {
        // Kilidi beklerken başka bir istek kurulumu tamamlamış olabilir.
        throw new ConflictException('Kurulum zaten tamamlanmis');
      }

      const orgId = randomUUID();
      const slug = await this.uniqueSlug(client, orgName);

      // RLS: `users` (ve diğer kiracı-kapsamlı tablolar) `app.current_org`
      // oturum değişkenine bakan bir politikayla korunur (bkz.
      // DatabaseService.withTenant). Burada `withTenant` KULLANILMAZ çünkü
      // organizasyon henüz yok — ama INSERT'lerin RLS'yi geçmesi için aynı
      // `set_config`'i elle, transaction'a LOCAL olarak (üçüncü parametre
      // `true`) uygulamak gerekir. Yeni üretilen `orgId` bu amaç için
      // yeterlidir; satır az sonra zaten gerçekten oluşturulacaktır.
      await client.query('SELECT set_config($1, $2, true)', ['app.current_org', orgId]);

      await client.query(
        `INSERT INTO organizations (id, slug, display_name, is_active)
         VALUES ($1, $2, $3, true)`,
        [orgId, slug, orgName],
      );

      // Sistem ADMIN rolü şemayla birlikte önceden yüklenir (org_id NULL,
      // bkz. 001_schema.sql). Organizasyona özgü bir rol oluşturmaya gerek
      // yoktur — bu rol tüm organizasyonlarda paylaşılır.
      const adminRole = await client.query<{ id: string }>(
        `SELECT id FROM roles WHERE key = 'ADMIN' AND org_id IS NULL LIMIT 1`,
      );
      if (adminRole.rowCount === 0) {
        // Şema doğru uygulanmadıysa (migration atlanmış) burada patlamak,
        // rolsüz bir "yönetici" hesabı oluşturmaktan çok daha güvenlidir.
        throw new Error('Sistem ADMIN rolu bulunamadi — semanin dogru uygulandigini kontrol edin');
      }

      const userId = randomUUID();
      await client.query(
        `INSERT INTO users (
           id, org_id, email, display_name, password_hash, status, token_version
         ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 0)`,
        [userId, orgId, input.adminEmail.toLowerCase(), displayName, passwordHash],
      );

      await client.query(
        `INSERT INTO user_roles (id, user_id, role_id) VALUES ($1, $2, $3)`,
        [randomUUID(), userId, adminRole.rows[0]!.id],
      );

      return { orgId, orgSlug: slug, userId };
    });

    // Kritik bir güvenlik olayıdır: bir dağıtımın İLK yönetici hesabının
    // ne zaman ve nereden oluşturulduğu her zaman izlenebilir olmalıdır.
    await this.audit.record({
      orgId: result.orgId,
      actorId: result.userId,
      actorEmail: input.adminEmail.toLowerCase(),
      action: 'setup.bootstrap',
      resourceType: 'organization',
      resourceId: result.orgId,
      outcome: 'SUCCESS',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { orgSlug: result.orgSlug, severity: 'high' },
    });

    this.logger.warn(
      { orgSlug: result.orgSlug, adminEmail: input.adminEmail },
      'ILK KURULUM TAMAMLANDI — yeni organizasyon ve yonetici hesabi olusturuldu',
    );

    // Oluşturulan hesapla ANINDA oturum aç — aynı transaction'da yazılan
    // parola karmasını tekrar sorgulayıp doğrulamak yerine, zaten bilinen
    // kimlik bilgileriyle standart giriş yolunu (audit + token üretimi
    // dahil) çağırmak tek bir doğruluk kaynağını korur.
    const session = await this.auth.loginWithPassword(
      result.orgSlug,
      input.adminEmail,
      input.adminPassword,
      context,
    );

    // `orgSlug` istemciye buradan taşınır: sonraki girişlerde LoginScreen
    // formunun hangi organizasyon adresini dolduracağını bilmesi gerekir.
    // E-posta alan adından türetmek YANLIŞ olurdu (`admin@sirket.com` ≠
    // org slug'ı `acme-corp` olabilir) — bu yüzden gerçek slug taşınır.
    return { ...session, orgSlug: result.orgSlug };
  }

  /**
   * Organizasyon adından benzersiz bir slug türetir.
   *
   * Çakışma durumunda `-2`, `-3` ... eklenir. Bu yalnızca kurulum
   * sihirbazında çalışır ve tek bir organizasyon oluşturulacağı için
   * pratikte çakışma neredeyse hiç olmaz; yine de üretim kalitesinde bir
   * kod, ele alınmamış bir kısıt ihlaline güvenmemelidir.
   */
  private async uniqueSlug(client: PoolClient, name: string): Promise<string> {
    const turkishMap: Record<string, string> = {
      ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
      Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u',
    };

    const base = name
      .replace(/[çğıöşüÇĞİÖŞÜ]/gu, (char) => turkishMap[char] ?? char)
      .toLocaleLowerCase('en-US')
      .normalize('NFD')
      .replace(/[̀-ͯ]/gu, '')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 50) || 'organizasyon';

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const result = await client.query('SELECT 1 FROM organizations WHERE slug = $1', [candidate]);
      if ((result.rowCount ?? 0) === 0) return candidate;
    }

    // 20 denemede de çakışıyorsa (pratikte imkânsıza yakın) rastgele bir
    // sonek ekleyerek devam et — kurulumun bu yüzden tıkanması kabul edilemez.
    return `${base}-${randomUUID().slice(0, 8)}`;
  }
}
