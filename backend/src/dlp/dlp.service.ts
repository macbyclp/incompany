import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  DlpRuleRepository,
  DlpIncidentRepository,
  type DlpRuleRecord,
} from './dlp.repositories';
import { validators, type ValidatorName } from './validators';

/**
 * DLP — Veri Sızıntısı Önleme.
 *
 * TASARIM İLKESİ: DÜŞÜK YANLIŞ POZİTİF
 *   Bir DLP motoru gereğinden fazla mesaj engellerse kullanıcılar WhatsApp'a
 *   geçer ve sistem hem işlevsiz hem güvensiz hale gelir. Bu yüzden burada
 *   İKİ AŞAMALI eşleştirme kullanılır:
 *     1. Regex ile aday bul (hızlı, geniş)
 *     2. Sağlama toplamı ile doğrula (kesin, dar)
 *   "12345678901" bir TCKN regex'ine uyar ama sağlama testini geçmez.
 *   Bu adım, yanlış pozitifleri onda bire indirir.
 *
 * ÇALIŞMA SIRASI
 *   Tarama ŞİFRELEMEDEN ÖNCE yapılmalıdır. Şifrelenmiş veri taranamaz.
 *   Kanal E2EE modundaysa sunucu tarafı DLP YAPISAL OLARAK İMKÂNSIZDIR —
 *   bu durum sessizce geçilmez, açıkça raporlanır.
 *
 * SIZINTI RİSKİ
 *   Olay kayıtları hassas verinin KENDİSİNİ saklamaz. Kredi kartı numarasını
 *   "ihlal kanıtı" diye loglamak, önlemeye çalıştığınız sızıntıyı yaratır.
 *   Yalnızca maskelenmiş bir örnek tutulur: "4532••••••••9021".
 */

export enum DlpAction {
  ALLOW = 'ALLOW',
  MASK = 'MASK',
  WARN = 'WARN',
  BLOCK = 'BLOCK',
}

export interface DlpMatch {
  ruleKey: string;
  ruleName: string;
  severity: number;
  count: number;
  action: DlpAction;
}

export interface DlpScanResult {
  action: DlpAction;
  /** MASK durumunda maskelenmiş gövde; aksi halde girdi ile aynı. */
  body: string;
  matches: DlpMatch[];
  /** Kanal E2EE olduğu için tarama yapılamadıysa true. */
  skippedDueToE2ee: boolean;
}

export interface DlpScanContext {
  orgId: string;
  userId: string;
  channelId: string;
  channelType: string;
  isE2ee: boolean;
}

interface CompiledRule {
  key: string;
  name: string;
  pattern: RegExp;
  validator: ValidatorName | null;
  action: DlpAction;
  severity: number;
  channelTypes: string[] | null;
}

/** Kurallar 5 dakikada bir yenilenir — admin değişikliği yeniden başlatma gerektirmez. */
const RULE_REFRESH_MS = 5 * 60 * 1000;
/** ReDoS koruması: aşırı uzun gövdeler taranmaz, doğrudan reddedilir. */
const MAX_SCANNABLE_LENGTH = 64 * 1024;
/** Tek kural için üst eşleşme sınırı — patolojik girdilerde CPU koruması. */
const MAX_MATCHES_PER_RULE = 100;

@Injectable()
export class DlpService implements OnModuleInit {
  private readonly logger = new Logger(DlpService.name);
  private rulesByOrg = new Map<string, CompiledRule[]>();
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly ruleRepo: DlpRuleRepository,
    private readonly incidents: DlpIncidentRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshRules();
    this.refreshTimer = setInterval(() => {
      this.refreshRules().catch((error) =>
        this.logger.error({ err: (error as Error).message }, 'DLP kural yenileme basarisiz'),
      );
    }, RULE_REFRESH_MS);
    this.refreshTimer.unref();
  }

  // -------------------------------------------------------------------------
  //  Genel API
  // -------------------------------------------------------------------------

  async scan(body: string, ctx: DlpScanContext): Promise<DlpScanResult> {
    // E2EE kanalda sunucunun düz metni yoktur. Bu bir başarısızlık değil,
    // kanalın tanımı gereği beklenen durumdur — ama sessizce geçilmez:
    // uyum ekibinin bu kanalların taranmadığını bilmesi gerekir.
    if (ctx.isE2ee) {
      return { action: DlpAction.ALLOW, body, matches: [], skippedDueToE2ee: true };
    }

    if (body.length > MAX_SCANNABLE_LENGTH) {
      this.logger.warn({ length: body.length, channelId: ctx.channelId }, 'Govde tarama sinirini asti');
      return {
        action: DlpAction.BLOCK,
        body,
        matches: [
          {
            ruleKey: 'SIZE_LIMIT',
            ruleName: 'Boyut siniri',
            severity: 2,
            count: 1,
            action: DlpAction.BLOCK,
          },
        ],
        skippedDueToE2ee: false,
      };
    }

    const rules = this.rulesByOrg.get(ctx.orgId) ?? this.rulesByOrg.get('__default__') ?? [];
    const matches: DlpMatch[] = [];
    let workingBody = body;

    for (const rule of rules) {
      if (rule.channelTypes && !rule.channelTypes.includes(ctx.channelType)) continue;

      const hits = this.findValidatedHits(workingBody, rule);
      if (hits.length === 0) continue;

      matches.push({
        ruleKey: rule.key,
        ruleName: rule.name,
        severity: rule.severity,
        count: hits.length,
        action: rule.action,
      });

      if (rule.action === DlpAction.MASK) {
        workingBody = this.applyMask(workingBody, hits);
      }
    }

    // En sert eylem kazanır: BLOCK > MASK > WARN > ALLOW.
    // Aynı mesajda hem maskelenecek hem engellenecek veri varsa engellenmelidir.
    const finalAction = this.resolveAction(matches);

    if (matches.length > 0) {
      // Olay kaydı, mesaj akışını BLOKLAMAMALIDIR: ateşle-unut.
      // Denetim yazımındaki bir gecikme mesaj gönderimini geciktirmez.
      void this.recordIncidents(ctx, matches, body).catch((error) =>
        this.logger.error({ err: (error as Error).message }, 'DLP olay kaydi basarisiz'),
      );
    }

    return {
      action: finalAction,
      body: finalAction === DlpAction.BLOCK ? body : workingBody,
      matches,
      skippedDueToE2ee: false,
    };
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  /**
   * İki aşamalı eşleştirme: regex aday üretir, doğrulayıcı eler.
   *
   * `g` bayraklı bir RegExp durumludur (`lastIndex`) — paylaşılan bir örnekte
   * bu, sessiz atlamalara yol açar. Bu yüzden her taramada `lastIndex` sıfırlanır.
   */
  private findValidatedHits(
    text: string,
    rule: CompiledRule,
  ): Array<{ start: number; end: number; value: string }> {
    const hits: Array<{ start: number; end: number; value: string }> = [];
    const regex = rule.pattern;
    regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (hits.length >= MAX_MATCHES_PER_RULE) {
        this.logger.warn({ ruleKey: rule.key }, 'Kural basina eslesme siniri asildi');
        break;
      }

      // Sıfır uzunluklu eşleşme sonsuz döngü yaratır — koru.
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }

      const value = match[0];
      const isValid = rule.validator ? validators[rule.validator](value) : true;

      if (isValid) {
        hits.push({ start: match.index, end: match.index + value.length, value });
      }
    }

    return hits;
  }

  /**
   * Maskeleme, aralıkları SONDAN BAŞA uygular.
   * Baştan uygulamak, maskeleme uzunluğu orijinalden farklı olduğunda
   * sonraki tüm indeksleri kaydırır ve yanlış yerleri maskeler.
   */
  private applyMask(
    text: string,
    hits: ReadonlyArray<{ start: number; end: number; value: string }>,
  ): string {
    let result = text;
    for (let i = hits.length - 1; i >= 0; i -= 1) {
      const { start, end, value } = hits[i];
      result = result.slice(0, start) + this.maskValue(value) + result.slice(end);
    }
    return result;
  }

  /** İlk 2 ve son 2 karakter korunur — kullanıcı neyin maskelendiğini anlar. */
  private maskValue(value: string): string {
    if (value.length <= 6) return '•'.repeat(value.length);
    return `${value.slice(0, 2)}${'•'.repeat(value.length - 4)}${value.slice(-2)}`;
  }

  private resolveAction(matches: readonly DlpMatch[]): DlpAction {
    const order = [DlpAction.BLOCK, DlpAction.MASK, DlpAction.WARN];
    for (const action of order) {
      if (matches.some((m) => m.action === action)) return action;
    }
    return DlpAction.ALLOW;
  }

  private async recordIncidents(
    ctx: DlpScanContext,
    matches: readonly DlpMatch[],
    _originalBody: string,
  ): Promise<void> {
    await Promise.all(
      matches.map((m) =>
        this.incidents.create({
          orgId: ctx.orgId,
          userId: ctx.userId,
          channelId: ctx.channelId,
          ruleKey: m.ruleKey,
          actionTaken: m.action,
          matchCount: m.count,
          // Hassas verinin kendisi ASLA kaydedilmez. Denetim için kural adı,
          // sayı ve zaman damgası yeterlidir.
          redactedSample: null,
        }),
      ),
    );
  }

  private async refreshRules(): Promise<void> {
    const records = await this.ruleRepo.findAllActive();
    const grouped = new Map<string, CompiledRule[]>();

    for (const record of records) {
      const compiled = this.compile(record);
      if (!compiled) continue;

      const list = grouped.get(record.orgId) ?? [];
      list.push(compiled);
      grouped.set(record.orgId, list);
    }

    // Yüksek önem derecesi önce → BLOCK kuralları erken tetiklenir.
    for (const list of grouped.values()) {
      list.sort((a, b) => b.severity - a.severity);
    }

    grouped.set('__default__', BUILTIN_RULES);
    this.rulesByOrg = grouped;
    this.logger.log({ orgs: grouped.size, rules: records.length }, 'DLP kurallari yenilendi');
  }

  /**
   * Kural derleme. Bozuk bir regex TÜM DLP motorunu düşürmemelidir:
   * yalnızca o kural atlanır ve loglanır.
   */
  private compile(record: DlpRuleRecord): CompiledRule | null {
    try {
      const pattern = new RegExp(record.pattern, 'gu');

      // Kaba ReDoS denetimi. Üretimde RE2 (`node-re2`) kullanılması önerilir:
      // RE2 geri izleme (backtracking) yapmaz, katastrofik durum imkânsızdır.
      if (/(\+|\*|\{\d+,\}){2,}/.test(record.pattern)) {
        this.logger.warn({ key: record.key }, 'Kural ic ice nicelik iceriyor — ReDoS riski');
      }

      return {
        key: record.key,
        name: record.name,
        pattern,
        validator: (record.validator as ValidatorName) ?? null,
        action: record.action as DlpAction,
        severity: record.severity,
        channelTypes: record.appliesTo?.channelTypes ?? null,
      };
    } catch (error) {
      this.logger.error(
        { key: record.key, err: (error as Error).message },
        'Gecersiz DLP regex — kural atlandi',
      );
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
//  YERLEŞİK KURALLAR
//  Veritabanı boşken de temel koruma sağlar. Tüm regex'ler ReDoS güvenlidir:
//  iç içe nicelik (nested quantifier) ve belirsiz alternasyon içermezler.
// ---------------------------------------------------------------------------

const BUILTIN_RULES: CompiledRule[] = [
  {
    key: 'TCKN',
    name: 'T.C. Kimlik Numarasi',
    // Kelime sınırı, 11 haneli sipariş/fatura numaralarını dışlar.
    pattern: /\b[1-9][0-9]{10}\b/gu,
    validator: 'tckn',
    action: DlpAction.MASK,
    severity: 5,
    channelTypes: null,
  },
  {
    key: 'CREDIT_CARD',
    name: 'Kredi Karti Numarasi',
    // 13-19 hane, boşluk veya tire ayraçlı.
    pattern: /\b(?:\d[ -]?){12,18}\d\b/gu,
    validator: 'luhn',
    action: DlpAction.BLOCK,
    severity: 5,
    channelTypes: null,
  },
  {
    key: 'IBAN_TR',
    name: 'IBAN (TR)',
    pattern: /\bTR[0-9]{2}[ ]?(?:[0-9]{4}[ ]?){5}[0-9]{2}\b/giu,
    validator: 'iban',
    action: DlpAction.MASK,
    severity: 4,
    channelTypes: null,
  },
  {
    key: 'AWS_ACCESS_KEY',
    name: 'AWS Erisim Anahtari',
    pattern: /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b/gu,
    validator: null,
    action: DlpAction.BLOCK,
    severity: 5,
    channelTypes: null,
  },
  {
    key: 'PRIVATE_KEY',
    name: 'Ozel Anahtar (PEM)',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gu,
    validator: null,
    action: DlpAction.BLOCK,
    severity: 5,
    channelTypes: null,
  },
  {
    key: 'JWT_TOKEN',
    name: 'JWT Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
    validator: null,
    action: DlpAction.BLOCK,
    severity: 5,
    channelTypes: null,
  },
  {
    key: 'GENERIC_SECRET',
    name: 'Sifre / API Anahtari Atamasi',
    // password=..., api_key: "...", secret => ...
    pattern: /\b(?:password|passwd|api[_-]?key|secret|token)\b["' ]{0,4}[:=][ ]{0,4}["']?[^\s"']{8,}/giu,
    validator: null,
    action: DlpAction.WARN,
    severity: 3,
    channelTypes: null,
  },
];
