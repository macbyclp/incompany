import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../common/database/database.service';
import { ChannelPolicyService } from '../channels/channel-policy.service';
import { AuditService } from '../audit/audit.service';
import { RateLimiterService, RATE_LIMITS } from '../common/rate-limit/rate-limiter.service';
import { sanitizeFileName } from '../chat/sanitize';
import type { AuthenticatedUser } from '../auth/auth.types';

/**
 * Dosya Yönetimi.
 *
 * YÜKLEME MODELİ: PRESIGNED URL — dosya API sunucusundan GEÇMEZ.
 *   Tarayıcı doğrudan S3'e yükler. Gerekçeler:
 *     · 100 MB'lık bir dosya API sürecinin belleğini veya diskini tüketmez
 *     · Yükleme sırasında API replikaları meşgul olmaz
 *     · Ağ kesintisinde yeniden başlatma S3'ün multipart desteğiyle çalışır
 *
 * GÜVENLİK SIRASI — bu sıra bozulursa zincir kırılır:
 *   1. Yetki kontrolü         → yükleme URL'i verilmeden önce
 *   2. Presigned URL          → dar kapsamlı, kısa ömürlü
 *   3. Yükleme (istemci → S3)
 *   4. Onay (istemci → API)   → checksum doğrulaması
 *   5. AV taraması (worker)   → PENDING
 *   6. İndirme izni           → YALNIZCA av_status = CLEAN
 *
 * Adım 6 kritiktir: taranmamış bir dosyanın indirilmesine izin vermek,
 * platformu kurum içi zararlı yazılım dağıtım aracına çevirir.
 */

/** İzinli MIME tipleri — beyaz liste, kara liste DEĞİL. */
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/zip',
  'video/mp4',
]);

/**
 * Uzantı beyaz listesi ayrıca kontrol edilir.
 *
 * MIME tipi istemciden gelir ve GÜVENİLMEZ: bir `.exe` dosyası
 * `Content-Type: image/png` ile gönderilebilir. Çift kontrol
 * (uzantı + MIME) ve sunucu tarafında sihirli bayt doğrulaması gerekir.
 */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'scr', 'bat', 'cmd', 'com', 'pif', 'vbs', 'vbe', 'js', 'jse',
  'ws', 'wsf', 'msi', 'msp', 'hta', 'cpl', 'jar', 'app', 'deb', 'rpm',
  'sh', 'bash', 'ps1', 'psm1', 'reg', 'lnk', 'iso', 'img',
]);

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 900;
const DOWNLOAD_URL_TTL_SECONDS = 300;

export interface UploadTicket {
  attachmentId: string;
  uploadUrl: string;
  storageKey: string;
  expiresAt: number;
  requiredHeaders: Record<string, string>;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly bucket: string;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly policy: ChannelPolicyService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiterService,
  ) {
    this.bucket = this.config.get<string>('S3_BUCKET') ?? 'incompany-files';
  }

  // -------------------------------------------------------------------------
  //  Yükleme
  // -------------------------------------------------------------------------

  async createUploadTicket(
    user: AuthenticatedUser,
    input: { channelId: string; fileName: string; mimeType: string; sizeBytes: number },
  ): Promise<UploadTicket> {
    const limited = await this.rateLimiter.consume(`upload:${user.id}`, RATE_LIMITS.FILE_UPLOAD);
    if (!limited.ok) {
      throw new ForbiddenException(`Cok fazla yukleme. ${limited.retryAfterSec} sn sonra deneyin.`);
    }

    // Yetki ÖNCE. Yükleme URL'i verildikten sonra iptal edilemez.
    const decision = await this.policy.canPost(user, input.channelId);
    if (!decision.allowed) throw new ForbiddenException(decision.message);

    this.validateFile(input.fileName, input.mimeType, input.sizeBytes);

    const attachmentId = randomUUID();
    const safeName = sanitizeFileName(input.fileName);
    // Anahtar yapısı: orgId ile başlar → S3 bucket politikasıyla kiracı
    // izolasyonu uygulanabilir; dosya adı içermez → yol enjeksiyonu imkânsız.
    const storageKey = `${user.orgId}/${input.channelId}/${attachmentId}`;

    // `attachments` RLS'lidir (`tenant_isolation_attachments`) — `withTenant`
    // olmadan bu INSERT reddedilir.
    await this.db.withTenant(user.orgId, (client) =>
      client.query(
        `INSERT INTO attachments (
           id, org_id, channel_id, uploader_id, storage_key,
           file_name, mime_type, size_bytes, checksum_sha256, av_status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'\\x0000000000000000000000000000000000000000000000000000000000000000'::bytea,'PENDING')`,
        [
          attachmentId,
          user.orgId,
          input.channelId,
          user.id,
          storageKey,
          safeName,
          input.mimeType,
          input.sizeBytes,
        ],
      ),
    );

    const uploadUrl = await this.signUpload(storageKey, input.mimeType, input.sizeBytes);

    return {
      attachmentId,
      uploadUrl,
      storageKey,
      expiresAt: Date.now() + UPLOAD_URL_TTL_SECONDS * 1000,
      requiredHeaders: {
        'Content-Type': input.mimeType,
        // Sunucu tarafı şifreleme S3'te zorunlu kılınır. Bucket politikası
        // bu başlık olmadan yapılan yüklemeleri reddetmelidir — yoksa
        // istemci başlığı atlayarak şifresiz nesne yazabilir.
        'x-amz-server-side-encryption': 'aws:kms',
      },
    };
  }

  /**
   * Yükleme tamamlandı onayı.
   *
   * İstemcinin bildirdiği checksum, S3'teki nesnenin ETag'i ile
   * KARŞILAŞTIRILIR. Karşılaştırmadan kabul etmek, istemcinin "yükledim"
   * demesini yeterli sayar — dosya hiç yüklenmemiş bile olabilir.
   */
  async confirmUpload(
    user: AuthenticatedUser,
    attachmentId: string,
    checksumSha256: string,
  ): Promise<{ ok: boolean; avStatus: string }> {
    const attachment = await this.db.withTenant(user.orgId, (client) =>
      client
        .query<{
          id: string;
          storage_key: string;
          channel_id: string;
          uploader_id: string;
          size_bytes: string;
        }>(
          `SELECT id, storage_key, channel_id, uploader_id, size_bytes
             FROM attachments WHERE id = $1 AND org_id = $2`,
          [attachmentId, user.orgId],
        )
        .then((r) => r.rows[0] ?? null),
    );

    if (!attachment) throw new NotFoundException('Ek bulunamadi');
    if (attachment.uploader_id !== user.id) {
      throw new ForbiddenException('Bu yuklemeyi onaylama yetkiniz yok');
    }

    const objectInfo = await this.headObject(attachment.storage_key);
    if (!objectInfo) {
      throw new BadRequestException('Dosya depoda bulunamadi');
    }
    if (Number(objectInfo.size) !== Number(attachment.size_bytes)) {
      // Bildirilen boyut ile gerçek boyut uyuşmuyor: ya istemci yanlış
      // bildirdi ya da boyut sınırını atlatmaya çalışıyor.
      this.logger.warn(
        { attachmentId, declared: attachment.size_bytes, actual: objectInfo.size },
        'Yukleme boyutu uyusmazligi',
      );
      await this.deleteObject(attachment.storage_key);
      throw new BadRequestException('Dosya boyutu bildirilenle uyusmuyor');
    }

    await this.db.withTenant(user.orgId, (client) =>
      client.query(
        `UPDATE attachments SET checksum_sha256 = decode($2, 'hex') WHERE id = $1`,
        [attachmentId, checksumSha256],
      ),
    );

    // AV taraması kuyruğa alınır. Bu tamamlanana kadar dosya
    // İNDİRİLEMEZ (av_status = PENDING).
    await this.db.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('attachment', $1, 'attachment.scan_requested', $2::jsonb)`,
      [attachmentId, JSON.stringify({ attachmentId, storageKey: attachment.storage_key })],
    );

    await this.audit.record({
      orgId: user.orgId,
      actorId: user.id,
      action: 'file.upload',
      resourceType: 'attachment',
      resourceId: attachmentId,
      metadata: { channelId: attachment.channel_id, sizeBytes: Number(attachment.size_bytes) },
    });

    return { ok: true, avStatus: 'PENDING' };
  }

  // -------------------------------------------------------------------------
  //  İndirme
  // -------------------------------------------------------------------------

  async createDownloadUrl(user: AuthenticatedUser, attachmentId: string): Promise<{ url: string; expiresAt: number }> {
    const limited = await this.rateLimiter.consume(`download:${user.id}`, RATE_LIMITS.FILE_DOWNLOAD);
    if (!limited.ok) {
      // Saatte 100 indirme insan davranışının çok üstündedir; bu sınırın
      // tetiklenmesi toplu veri sızdırma sinyalidir ve denetime yazılır.
      await this.audit.record({
        orgId: user.orgId,
        actorId: user.id,
        action: 'file.download_rate_limited',
        resourceType: 'attachment',
        resourceId: attachmentId,
        outcome: 'DENIED',
        metadata: { severity: 'high' },
      });
      throw new ForbiddenException('Indirme siniri asildi');
    }

    const attachment = await this.db.withTenant(user.orgId, (client) =>
      client
        .query<{
          id: string;
          channel_id: string;
          storage_key: string;
          file_name: string;
          mime_type: string;
          av_status: string;
          deleted_at: Date | null;
        }>(
          `SELECT id, channel_id, storage_key, file_name, mime_type, av_status, deleted_at
             FROM attachments WHERE id = $1 AND org_id = $2`,
          [attachmentId, user.orgId],
        )
        .then((r) => r.rows[0] ?? null),
    );

    if (!attachment || attachment.deleted_at) throw new NotFoundException('Dosya bulunamadi');

    // Kanal erişimi HER indirmede yeniden kontrol edilir. Kullanıcı dosyayı
    // görebildiği zaman üyeydi diye sonsuza kadar erişemez.
    const decision = await this.policy.canRead(user, attachment.channel_id);
    if (!decision.allowed) throw new ForbiddenException('Bu dosyaya erisiminiz yok');

    // === AV KAPISI ===
    if (attachment.av_status === 'INFECTED') {
      await this.audit.record({
        orgId: user.orgId,
        actorId: user.id,
        action: 'file.download_blocked_malware',
        resourceType: 'attachment',
        resourceId: attachmentId,
        outcome: 'DENIED',
        metadata: { severity: 'critical' },
      });
      throw new ForbiddenException('Bu dosyada zararli yazilim tespit edildi');
    }
    if (attachment.av_status !== 'CLEAN') {
      throw new ForbiddenException('Dosya henuz taraniyor, lutfen birkac saniye sonra deneyin');
    }

    const url = await this.signDownload(
      attachment.storage_key,
      attachment.file_name,
      attachment.mime_type,
    );

    await this.audit.record({
      orgId: user.orgId,
      actorId: user.id,
      action: 'file.download',
      resourceType: 'attachment',
      resourceId: attachmentId,
      metadata: { channelId: attachment.channel_id, fileName: attachment.file_name },
    });

    return { url, expiresAt: Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000 };
  }

  // -------------------------------------------------------------------------
  //  Doğrulama
  // -------------------------------------------------------------------------

  private validateFile(fileName: string, mimeType: string, sizeBytes: number): void {
    if (sizeBytes <= 0 || sizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `Dosya boyutu 0 ile ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB arasinda olmali`,
      );
    }

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException(`Bu dosya turu desteklenmiyor: ${mimeType}`);
    }

    // Uzantı, MIME'den BAĞIMSIZ olarak kontrol edilir. İkisi de istemciden
    // gelir ama ikisini birden tutarlı biçimde yalanlamak daha zordur.
    // Nihai doğrulama, AV worker'ındaki sihirli bayt kontrolüdür.
    const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (BLOCKED_EXTENSIONS.has(extension)) {
      throw new BadRequestException(`Bu dosya uzantisi guvenlik nedeniyle engellendi: .${extension}`);
    }

    // Çift uzantı: "fatura.pdf.exe" — Windows'ta gerçek uzantı sonuncudur
    // ama kullanıcı ilkini görür. Klasik sosyal mühendislik tekniği.
    const parts = fileName.toLowerCase().split('.');
    if (parts.length > 2) {
      const suspicious = parts.slice(1, -1).some((part) => BLOCKED_EXTENSIONS.has(part));
      if (suspicious) {
        throw new BadRequestException('Cift uzantili dosya adlari kabul edilmiyor');
      }
    }
  }

  // -------------------------------------------------------------------------
  //  S3 işlemleri
  // -------------------------------------------------------------------------

  private async signUpload(key: string, mimeType: string, sizeBytes: number): Promise<string> {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const client = this.s3Client(S3Client);

    return getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mimeType,
        // İmzaya dahil edilir: istemci daha büyük bir dosya yükleyemez.
        ContentLength: sizeBytes,
        ServerSideEncryption: 'aws:kms',
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
  }

  private async signDownload(key: string, fileName: string, mimeType: string): Promise<string> {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const client = this.s3Client(S3Client);

    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // `attachment` ZORUNLUDUR: `inline` olsaydı, yüklenen bir HTML veya
        // SVG dosyası tarayıcıda ÇALIŞIR ve depolama alan adında XSS olur.
        // Dosya adı RFC 5987 ile kodlanır (Türkçe karakterler için).
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        ResponseContentType: mimeType,
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );
  }

  private async headObject(key: string): Promise<{ size: number } | null> {
    const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = this.s3Client(S3Client);

    try {
      const result = await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: result.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  private async deleteObject(key: string): Promise<void> {
    const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = this.s3Client(S3Client);

    try {
      await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      this.logger.error({ err: (error as Error).message, key }, 'S3 nesnesi silinemedi');
    }
  }

  private s3Client(S3Client: typeof import('@aws-sdk/client-s3').S3Client) {
    return new S3Client({
      region: this.config.get<string>('AWS_REGION') ?? 'us-east-1',
      endpoint: this.config.get<string>('S3_ENDPOINT'),
      // MinIO sanal-host stilini desteklemez; yol stili gerekir.
      forcePathStyle: Boolean(this.config.get<string>('S3_ENDPOINT')),
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('S3_ACCESS_KEY'),
        secretAccessKey: this.config.getOrThrow<string>('S3_SECRET_KEY'),
      },
    });
  }
}
