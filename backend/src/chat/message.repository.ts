import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { MessageKind, type AttachmentDto } from '@incompany/contracts';

import { DatabaseService } from '../common/database/database.service';
import type { CipherEnvelope } from '../common/crypto/crypto.service';

/**
 * Mesaj Deposu — PostgreSQL uygulaması.
 *
 * Bu sınıf bir ARAYÜZ SÖZLEŞMESİ uygular. Ölçek ScyllaDB'yi gerektirdiğinde
 * `ScyllaMessageRepository` aynı imzaları sağlar ve `ChatService` hiç
 * değişmez (bkz. `db/scylla/001_messages.cql`).
 */

export interface MessageRow {
  id: string;
  channelId: string;
  seq: number;
  senderId: string | null;
  kind: MessageKind;
  envelope: CipherEnvelope;
  clientMsgId: string;
  replyToSeq: number | null;
  threadRootSeq: number | null;
  mentions: string[];
  attachments: AttachmentDto[];
  dlpVerdict: Record<string, unknown> | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface InsertMessageInput {
  id: string;
  orgId: string;
  channelId: string;
  senderId: string;
  kind: MessageKind;
  clientMsgId: string;
  envelope: CipherEnvelope;
  replyToSeq: number | null;
  mentions: string[];
  attachmentIds: string[];
  dlpVerdict: Record<string, unknown> | null;
}

/** Veritabanından dönen ham satır — snake_case. */
interface RawMessageRow {
  id: string;
  channel_id: string;
  seq: string; // BIGINT → pg tarafından string olarak döner
  sender_id: string | null;
  kind: MessageKind;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  cipher_scheme: number;
  client_msg_id: string;
  reply_to_id: string | null;
  reply_to_seq: string | null;
  thread_root_seq: string | null;
  mentions: string[];
  dlp_verdict: Record<string, unknown> | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  attachments: AttachmentDto[] | null;
}

/** Ekleri mesajlara bağlayan ortak alt sorgu — tekrar yazılmaması için. */
const ATTACHMENTS_SUBQUERY = `
  COALESCE((
    SELECT json_agg(json_build_object(
      'id',        a.id,
      'fileName',  a.file_name,
      'mimeType',  a.mime_type,
      'sizeBytes', a.size_bytes,
      'avStatus',  a.av_status
    ) ORDER BY a.created_at)
    FROM message_attachments ma
    JOIN attachments a ON a.id = ma.attachment_id
    WHERE ma.message_id = m.id AND a.deleted_at IS NULL
  ), '[]'::json) AS attachments
`;

@Injectable()
export class MessageRepository {
  private readonly logger = new Logger(MessageRepository.name);

  constructor(private readonly db: DatabaseService) {}

  // -------------------------------------------------------------------------
  //  Yazma
  // -------------------------------------------------------------------------

  /**
   * Mesajı sıra numarasıyla birlikte tek transaction'da yazar.
   *
   * ÜÇ İŞ ATOMİKTİR:
   *   1. `next_channel_seq()` — kanal satırını kilitler, seq'i artırır
   *   2. `INSERT INTO messages`
   *   3. `INSERT INTO outbox_events` — arama indeksleme, bildirim, analitik
   *
   * Outbox'ın AYNI transaction'da olması kritiktir: mesaj yazılıp olay
   * yazılamazsa arama indeksi kalıcı olarak eksik kalır. Ayrı bir Kafka
   * yazımı bu garantiyi veremez ("dual write" problemi).
   */
  async insertWithSeq(input: InsertMessageInput): Promise<MessageRow> {
    return this.db.withTenant(input.orgId, async (client) => {
      // 1. Sıra numarası — kanal satırı burada kilitlenir.
      //    Kilit süresi mümkün olduğunca kısa tutulmalı; bu yüzden
      //    şifreleme transaction'a GİRMEDEN önce yapılmıştır.
      const seqResult = await client.query<{ seq: string }>(
        'SELECT next_channel_seq($1) AS seq',
        [input.channelId],
      );
      const seq = Number(seqResult.rows[0].seq);

      // 2. Yanıtlanan mesajın kimliğini ve konu kökünü çöz.
      const threadInfo = input.replyToSeq
        ? await this.resolveThreadRoot(client, input.channelId, input.replyToSeq)
        : { replyToId: null, threadRootSeq: null };

      // 3. Mesajı yaz.
      const inserted = await client.query<RawMessageRow>(
        `INSERT INTO messages (
           id, org_id, channel_id, sender_id, kind, seq, client_msg_id,
           ciphertext, iv, auth_tag, key_version, cipher_scheme,
           reply_to_id, thread_root_id, mentions, has_attachment, dlp_verdict
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17
         )
         RETURNING id, channel_id, seq, sender_id, kind, client_msg_id,
                   ciphertext, iv, auth_tag, key_version, cipher_scheme,
                   reply_to_id, mentions, dlp_verdict, edited_at, deleted_at, created_at`,
        [
          input.id,
          input.orgId,
          input.channelId,
          input.senderId,
          input.kind,
          seq,
          input.clientMsgId,
          input.envelope.ciphertext,
          input.envelope.iv,
          input.envelope.authTag,
          input.envelope.keyVersion,
          input.envelope.scheme,
          threadInfo.replyToId,
          threadInfo.threadRootId ?? null,
          input.mentions,
          input.attachmentIds.length > 0,
          input.dlpVerdict ? JSON.stringify(input.dlpVerdict) : null,
        ],
      );

      // 4. Ekleri bağla.
      if (input.attachmentIds.length > 0) {
        await client.query(
          `INSERT INTO message_attachments (message_id, attachment_id)
           SELECT $1, unnest($2::uuid[])`,
          [input.id, input.attachmentIds],
        );
      }

      // 5. Outbox — düz metin BURAYA YAZILMAZ.
      //    Tüketiciler (indexer) mesajı ayrıca okuyup çözer. Düz metni
      //    outbox'a koymak, şifrelemeyi anlamsız kılar: aynı veritabanında
      //    şifresiz bir kopya oluşur.
      await client.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('message', $1, 'message.created', $2::jsonb)`,
        [
          input.id,
          JSON.stringify({
            messageId: input.id,
            channelId: input.channelId,
            orgId: input.orgId,
            senderId: input.senderId,
            seq,
            mentions: input.mentions,
            hasAttachment: input.attachmentIds.length > 0,
          }),
        ],
      );

      // 6. Gönderenin okuma imlecini kendi mesajına ilerlet — kendi
      //    mesajınız okunmamış olarak görünmemelidir.
      await client.query(
        `UPDATE channel_members
            SET last_read_seq      = GREATEST(last_read_seq, $3),
                last_delivered_seq = GREATEST(last_delivered_seq, $3)
          WHERE channel_id = $1 AND user_id = $2`,
        [input.channelId, input.senderId, seq],
      );

      const row = this.toRow(inserted.rows[0]);
      row.threadRootSeq = threadInfo.threadRootSeq;
      row.attachments = [];
      return row;
    });
  }

  async softDelete(
    orgId: string,
    channelId: string,
    seq: number,
    deletedBy: string,
  ): Promise<Date | null> {
    return this.db.withTenant(orgId, async (client) => {
      const result = await client.query<{ deleted_at: Date }>(
        `UPDATE messages
            SET deleted_at = now(), deleted_by = $3,
                -- Şifreli gövde de temizlenir. Mantıksal silmede içeriği
                -- bırakmak, DB erişimi olan birinin "silinmiş" mesajları
                -- okuyabilmesi demektir — silme sözü tutulmamış olur.
                ciphertext = '\\x'::bytea, auth_tag = '\\x00000000000000000000000000000000'::bytea
          WHERE channel_id = $1 AND seq = $2 AND deleted_at IS NULL
          RETURNING deleted_at`,
        [channelId, seq, deletedBy],
      );
      return result.rows[0]?.deleted_at ?? null;
    });
  }

  async updateBody(
    orgId: string,
    channelId: string,
    seq: number,
    envelope: CipherEnvelope,
  ): Promise<Date | null> {
    return this.db.withTenant(orgId, async (client) => {
      const result = await client.query<{ edited_at: Date }>(
        `UPDATE messages
            SET ciphertext = $3, iv = $4, auth_tag = $5,
                key_version = $6, edited_at = now()
          WHERE channel_id = $1 AND seq = $2 AND deleted_at IS NULL
          RETURNING edited_at`,
        [channelId, seq, envelope.ciphertext, envelope.iv, envelope.authTag, envelope.keyVersion],
      );
      return result.rows[0]?.edited_at ?? null;
    });
  }

  // -------------------------------------------------------------------------
  //  Okuma
  // -------------------------------------------------------------------------

  /** Boşluk doldurma: `sinceSeq`'ten sonraki mesajlar, artan sırada. */
  async findAfterSeq(channelId: string, sinceSeq: number, limit: number): Promise<MessageRow[]> {
    const rows = await this.db.query<RawMessageRow>(
      `SELECT m.id, m.channel_id, m.seq, m.sender_id, m.kind, m.client_msg_id,
              m.ciphertext, m.iv, m.auth_tag, m.key_version, m.cipher_scheme,
              m.reply_to_id, m.mentions, m.dlp_verdict,
              m.edited_at, m.deleted_at, m.created_at,
              rt.seq AS reply_to_seq,
              ${ATTACHMENTS_SUBQUERY}
         FROM messages m
         LEFT JOIN messages rt ON rt.id = m.reply_to_id
        WHERE m.channel_id = $1 AND m.seq > $2
        ORDER BY m.seq ASC
        LIMIT $3`,
      [channelId, sinceSeq, limit],
    );
    return rows.map((row) => this.toRow(row));
  }

  /** Geçmişe kaydırma: `beforeSeq`'ten önceki mesajlar, azalan sırada. */
  async findBeforeSeq(
    channelId: string,
    beforeSeq: number | null,
    limit: number,
  ): Promise<MessageRow[]> {
    const rows = await this.db.query<RawMessageRow>(
      `SELECT m.id, m.channel_id, m.seq, m.sender_id, m.kind, m.client_msg_id,
              m.ciphertext, m.iv, m.auth_tag, m.key_version, m.cipher_scheme,
              m.reply_to_id, m.mentions, m.dlp_verdict,
              m.edited_at, m.deleted_at, m.created_at,
              rt.seq AS reply_to_seq,
              ${ATTACHMENTS_SUBQUERY}
         FROM messages m
         LEFT JOIN messages rt ON rt.id = m.reply_to_id
        -- $2 NULL ise en son mesajlardan başla. COALESCE yerine OR kullanmak,
        -- planlayıcının idx_messages_channel_seq indeksini kullanmasını sağlar.
        WHERE m.channel_id = $1 AND ($2::bigint IS NULL OR m.seq < $2)
        ORDER BY m.seq DESC
        LIMIT $3`,
      [channelId, beforeSeq, limit],
    );
    return rows.map((row) => this.toRow(row));
  }

  async findByIds(channelId: string, seqs: readonly number[]): Promise<MessageRow[]> {
    if (seqs.length === 0) return [];
    const rows = await this.db.query<RawMessageRow>(
      `SELECT m.id, m.channel_id, m.seq, m.sender_id, m.kind, m.client_msg_id,
              m.ciphertext, m.iv, m.auth_tag, m.key_version, m.cipher_scheme,
              m.reply_to_id, m.mentions, m.dlp_verdict,
              m.edited_at, m.deleted_at, m.created_at,
              NULL::bigint AS reply_to_seq,
              ${ATTACHMENTS_SUBQUERY}
         FROM messages m
        WHERE m.channel_id = $1 AND m.seq = ANY($2::bigint[])`,
      [channelId, seqs],
    );
    return rows.map((row) => this.toRow(row));
  }

  /**
   * Okuma imlecini ilerletir.
   *
   * `WHERE last_read_seq < $3` koşulu iki iş yapar:
   *   · İmleç yalnızca ileri gider (sırasız olaylar sayacı geri sıçratmaz)
   *   · Değişiklik olmayan durumda satır kilidi hiç alınmaz
   * `RETURNING` boş dönerse imleç zaten ileridedir → yayın yapılmaz.
   */
  async advanceReadCursor(
    channelId: string,
    userId: string,
    upToSeq: number,
  ): Promise<{ lastReadSeq: number; changed: boolean }> {
    const updated = await this.db.queryMaybe<{ last_read_seq: string }>(
      `UPDATE channel_members
          SET last_read_seq      = $3,
              -- CHECK (last_read_seq <= last_delivered_seq) kısıtı gereği
              -- iletilen imleç de en az okunan kadar ilerletilmelidir.
              last_delivered_seq = GREATEST(last_delivered_seq, $3),
              last_read_at       = now()
        WHERE channel_id = $1 AND user_id = $2 AND last_read_seq < $3
        RETURNING last_read_seq`,
      [channelId, userId, upToSeq],
    );

    if (updated) {
      return { lastReadSeq: Number(updated.last_read_seq), changed: true };
    }

    const current = await this.db.queryMaybe<{ last_read_seq: string }>(
      'SELECT last_read_seq FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId],
    );

    return { lastReadSeq: Number(current?.last_read_seq ?? 0), changed: false };
  }

  /** Bir kanaldaki üye okuma imleçleri — DM okundu göstergesi için. */
  async getReadCursors(channelId: string): Promise<Array<{ userId: string; lastReadSeq: number }>> {
    const rows = await this.db.query<{ user_id: string; last_read_seq: string }>(
      `SELECT user_id, last_read_seq
         FROM channel_members
        WHERE channel_id = $1 AND left_at IS NULL AND last_read_seq > 0`,
      [channelId],
    );
    return rows.map((r) => ({ userId: r.user_id, lastReadSeq: Number(r.last_read_seq) }));
  }

  // -------------------------------------------------------------------------
  //  Dahili
  // -------------------------------------------------------------------------

  /**
   * Konu başlığı kökünü çözer.
   *
   * Bir yanıta yanıt verildiğinde konu başlığı İÇ İÇE GEÇMEZ: kök hep aynı
   * kalır. Aksi halde 20 seviye derinlikte okunamaz bir ağaç oluşur.
   */
  private async resolveThreadRoot(
    client: PoolClient,
    channelId: string,
    replyToSeq: number,
  ): Promise<{ replyToId: string | null; threadRootId?: string | null; threadRootSeq: number | null }> {
    const result = await client.query<{
      id: string;
      seq: string;
      thread_root_id: string | null;
      root_seq: string | null;
    }>(
      `SELECT m.id, m.seq, m.thread_root_id, r.seq AS root_seq
         FROM messages m
         LEFT JOIN messages r ON r.id = m.thread_root_id
        WHERE m.channel_id = $1 AND m.seq = $2
        LIMIT 1`,
      [channelId, replyToSeq],
    );

    const parent = result.rows[0];
    if (!parent) {
      // Yanıtlanan mesaj silinmiş veya hiç var olmamış. Yanıt bağını
      // sessizce düşür — mesajın kendisi yine de gönderilebilmelidir.
      this.logger.debug({ channelId, replyToSeq }, 'Yanitlanan mesaj bulunamadi');
      return { replyToId: null, threadRootId: null, threadRootSeq: null };
    }

    // Ebeveyn zaten bir konu başlığındaysa aynı kökü kullan; değilse
    // ebeveynin kendisi kök olur.
    const rootId = parent.thread_root_id ?? parent.id;
    const rootSeq = parent.root_seq ? Number(parent.root_seq) : Number(parent.seq);

    return { replyToId: parent.id, threadRootId: rootId, threadRootSeq: rootSeq };
  }

  private toRow(raw: RawMessageRow): MessageRow {
    return {
      id: raw.id,
      channelId: raw.channel_id,
      // BIGINT pg tarafından string döner — hassasiyet kaybını önlemek için.
      // Kanal başına seq 2^53'ü aşmayacağı için Number güvenlidir.
      seq: Number(raw.seq),
      senderId: raw.sender_id,
      kind: raw.kind,
      envelope: {
        scheme: raw.cipher_scheme,
        keyVersion: raw.key_version,
        ciphertext: raw.ciphertext,
        iv: raw.iv,
        authTag: raw.auth_tag,
      },
      clientMsgId: raw.client_msg_id,
      replyToSeq: raw.reply_to_seq ? Number(raw.reply_to_seq) : null,
      threadRootSeq: raw.thread_root_seq ? Number(raw.thread_root_seq) : null,
      mentions: raw.mentions ?? [],
      attachments: raw.attachments ?? [],
      dlpVerdict: raw.dlp_verdict,
      editedAt: raw.edited_at,
      deletedAt: raw.deleted_at,
      createdAt: raw.created_at,
    };
  }
}
