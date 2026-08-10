import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../common/database/database.service';

export interface DlpRuleRecord {
  id: string;
  orgId: string;
  key: string;
  name: string;
  pattern: string;
  validator: string | null;
  action: string;
  severity: number;
  appliesTo: { channelTypes?: string[] } | null;
}

@Injectable()
export class DlpRuleRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Tüm etkin kuralları getirir (tüm kiracılar).
   *
   * DlpService bunları bellekte tutar ve 5 dakikada bir yeniler. Her mesajda
   * kural sorgusu yapmak, mesaj gönderiminin sıcak yoluna gereksiz bir
   * veritabanı gidiş-dönüşü ekler — kurallar dakikalarca değişmez.
   */
  async findAllActive(): Promise<DlpRuleRecord[]> {
    const rows = await this.db.query<{
      id: string;
      org_id: string;
      key: string;
      name: string;
      pattern: string;
      validator: string | null;
      action: string;
      severity: number;
      applies_to: { channelTypes?: string[] } | null;
    }>(
      `SELECT id, org_id, key, name, pattern, validator, action, severity, applies_to
         FROM dlp_rules
        WHERE is_active = true
        ORDER BY severity DESC`,
    );

    return rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      key: r.key,
      name: r.name,
      pattern: r.pattern,
      validator: r.validator,
      action: r.action,
      severity: r.severity,
      appliesTo: r.applies_to,
    }));
  }

  async upsert(rule: Omit<DlpRuleRecord, 'id'>): Promise<string> {
    const result = await this.db.queryOne<{ id: string }>(
      `INSERT INTO dlp_rules (org_id, key, name, pattern, validator, action, severity, applies_to)
       VALUES ($1,$2,$3,$4,$5,$6::dlp_action,$7,$8::jsonb)
       ON CONFLICT (org_id, key) DO UPDATE
         SET name = EXCLUDED.name, pattern = EXCLUDED.pattern,
             validator = EXCLUDED.validator, action = EXCLUDED.action,
             severity = EXCLUDED.severity, applies_to = EXCLUDED.applies_to,
             updated_at = now()
       RETURNING id`,
      [
        rule.orgId,
        rule.key,
        rule.name,
        rule.pattern,
        rule.validator,
        rule.action,
        rule.severity,
        JSON.stringify(rule.appliesTo ?? {}),
      ],
    );
    return result.id;
  }

  async deactivate(orgId: string, key: string): Promise<boolean> {
    const rows = await this.db.query(
      'UPDATE dlp_rules SET is_active = false, updated_at = now() WHERE org_id = $1 AND key = $2 RETURNING id',
      [orgId, key],
    );
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------

export interface DlpIncidentInput {
  orgId: string;
  userId: string | null;
  channelId: string | null;
  messageId?: string | null;
  ruleKey: string;
  actionTaken: string;
  matchCount: number;
  /** Hassas verinin KENDİSİ ASLA buraya yazılmaz. */
  redactedSample: string | null;
}

@Injectable()
export class DlpIncidentRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(input: DlpIncidentInput): Promise<void> {
    await this.db.query(
      `INSERT INTO dlp_incidents (
         org_id, rule_id, rule_key, user_id, channel_id, message_id,
         action_taken, match_count, redacted_sample
       )
       SELECT $1, r.id, $2, $3, $4, $5, $6::dlp_action, $7, $8
         FROM (SELECT id FROM dlp_rules WHERE org_id = $1 AND key = $2 LIMIT 1) r
       -- Yerleşik (veritabanında olmayan) bir kural tetiklendiyse rule_id
       -- NULL kalır ama olay yine de kaydedilmelidir.
       UNION ALL
       SELECT $1, NULL, $2, $3, $4, $5, $6::dlp_action, $7, $8
        WHERE NOT EXISTS (SELECT 1 FROM dlp_rules WHERE org_id = $1 AND key = $2)`,
      [
        input.orgId,
        input.ruleKey,
        input.userId,
        input.channelId,
        input.messageId ?? null,
        input.actionTaken,
        input.matchCount,
        input.redactedSample,
      ],
    );
  }

  /**
   * Kullanıcı bazlı ihlal özeti.
   * Tekrarlayan ihlaller genelde iki şeyden birini gösterir: eğitim eksikliği
   * veya kasıtlı sızdırma girişimi. Ayrım, sayı ve zamanlama desenindedir.
   */
  async summarizeByUser(
    orgId: string,
    from: Date,
    to: Date,
    limit = 50,
  ): Promise<Array<{ userId: string; ruleKey: string; incidentCount: number; lastAt: Date }>> {
    const rows = await this.db.query<{
      user_id: string;
      rule_key: string;
      incident_count: string;
      last_at: Date;
    }>(
      `SELECT user_id, rule_key, COUNT(*)::text AS incident_count, MAX(created_at) AS last_at
         FROM dlp_incidents
        WHERE org_id = $1 AND created_at BETWEEN $2 AND $3 AND user_id IS NOT NULL
        GROUP BY user_id, rule_key
        ORDER BY COUNT(*) DESC
        LIMIT $4`,
      [orgId, from, to, limit],
    );

    return rows.map((r) => ({
      userId: r.user_id,
      ruleKey: r.rule_key,
      incidentCount: Number(r.incident_count),
      lastAt: r.last_at,
    }));
  }
}
