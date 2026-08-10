/**
 * iNCompany — Paylaşılan WebSocket Event Sözleşmesi
 *
 * Bu dosya backend ve frontend tarafından ORTAK kullanılır.
 * Bir event'in şekli değiştiğinde her iki taraf da DERLEME ZAMANINDA kırılır;
 * çalışma zamanında "undefined is not a function" ile değil.
 *
 * Kural: bu dosyaya asla çalışma zamanı bağımlılığı (runtime dependency) eklenmez.
 */

// ---------------------------------------------------------------------------
//  Ortak tipler
// ---------------------------------------------------------------------------

export type Uuid = string;

export enum GlobalRole {
  ADMIN = 'ADMIN',
  DEPT_MANAGER = 'DEPT_MANAGER',
  EMPLOYEE = 'EMPLOYEE',
}

export enum ChannelType {
  DM = 'DM',
  GROUP = 'GROUP',
  DEPARTMENT = 'DEPARTMENT',
  ANNOUNCEMENT = 'ANNOUNCEMENT',
}

export enum ChannelVisibility {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
}

export enum ChannelMemberRole {
  OWNER = 'OWNER',
  MODERATOR = 'MODERATOR',
  MEMBER = 'MEMBER',
  READER = 'READER',
}

export enum PresenceStatus {
  ONLINE = 'ONLINE',
  AWAY = 'AWAY',
  BUSY = 'BUSY',
  DND = 'DND',
  OFFLINE = 'OFFLINE',
}

export enum MessageKind {
  TEXT = 'TEXT',
  FILE = 'FILE',
  SYSTEM = 'SYSTEM',
  CALL_EVENT = 'CALL_EVENT',
}

/** Sunucunun döndürdüğü hata kodları — istemci bunlara göre dallanır. */
export enum WsErrorCode {
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_A_MEMBER = 'NOT_A_MEMBER',
  CHANNEL_ARCHIVED = 'CHANNEL_ARCHIVED',
  RATE_LIMITED = 'RATE_LIMITED',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  DLP_BLOCKED = 'DLP_BLOCKED',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  INTERNAL = 'INTERNAL',
}

// ---------------------------------------------------------------------------
//  Veri transfer nesneleri
// ---------------------------------------------------------------------------

export interface MessageDto {
  id: Uuid;
  channelId: Uuid;
  /** Kanal içi monotonik sıra — sıralama ve boşluk tespitinin TEK kaynağı. */
  seq: number;
  senderId: Uuid | null;
  kind: MessageKind;
  /** Sunucuda çözülmüş düz metin. E2EE kanallarda şifreli gövde döner. */
  body: string;
  clientMsgId: Uuid;
  replyToSeq?: number;
  threadRootSeq?: number;
  mentions: Uuid[];
  attachments: AttachmentDto[];
  /** DLP maskeleme uygulandıysa doldurulur — istemci rozet gösterir. */
  dlpMasked?: boolean;
  editedAt?: string;
  deletedAt?: string;
  createdAt: string;
}

export interface AttachmentDto {
  id: Uuid;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** PENDING iken indirme bağlantısı verilmez. */
  avStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';
}

export interface PresenceDto {
  userId: Uuid;
  status: PresenceStatus;
  customText?: string;
  customEmoji?: string;
  lastSeenAt?: string;
}

/**
 * Ek alan taşımayan ack yanıtları için boş yük tipi.
 *
 * `Record<string, never>` KULLANILMAZ: "her string anahtar `never` olmalı"
 * anlamına gelir ve `{ ok: true }` ile kesişemez — `ok` özelliği indeks
 * imzasıyla çakışır. `Record<never, never>` ise gerçek anlamda boş bir
 * nesnedir ve sorunsuz kesişir.
 */
export type EmptyPayload = Record<never, never>;

/**
 * Tüm ack yanıtlarının ortak zarfı.
 *
 * Ayrımlı birleşim (discriminated union): `ok` alanı TypeScript'e hangi
 * dalın geçerli olduğunu söyler, istemcide `if (res.ok)` ile daraltılır.
 *
 * `correlationId` HER İKİ dalda da bulunur: bir başarı yanıtını da loglarda
 * izleyebilmek gerekir, yalnızca hataları değil.
 */
export type Ack<T> =
  | ({ ok: true; correlationId: string } & T)
  | { ok: false; code: WsErrorCode; message: string; correlationId: string };

// ---------------------------------------------------------------------------
//  İstemci → Sunucu
// ---------------------------------------------------------------------------

export interface SendMessagePayload {
  channelId: Uuid;
  /** İstemcide üretilen UUID. Yeniden gönderimde AYNI değer kullanılmalıdır. */
  clientMsgId: Uuid;
  body: string;
  replyToSeq?: number;
  attachmentIds?: Uuid[];
  mentions?: Uuid[];
}

export interface ClientToServerEvents {
  'message:send': (
    p: SendMessagePayload,
    ack: (r: Ack<{ messageId: Uuid; seq: number; serverTs: string; dlpMasked: boolean }>) => void,
  ) => void;

  'message:edit': (
    p: { channelId: Uuid; seq: number; body: string },
    ack: (r: Ack<{ editedAt: string }>) => void,
  ) => void;

  'message:delete': (
    p: { channelId: Uuid; seq: number },
    ack: (r: Ack<EmptyPayload>) => void,
  ) => void;

  'message:read': (
    p: { channelId: Uuid; upToSeq: number },
    ack: (r: Ack<{ unread: number }>) => void,
  ) => void;

  'channel:subscribe': (
    p: { channelIds: Uuid[] },
    ack: (r: Ack<{ joined: Uuid[]; denied: Uuid[] }>) => void,
  ) => void;

  'channel:unsubscribe': (
    p: { channelIds: Uuid[] },
    ack: (r: Ack<EmptyPayload>) => void,
  ) => void;

  /** Yeniden bağlanma sonrası boşluk doldurma. */
  'channel:sync': (
    p: { channelId: Uuid; sinceSeq: number; limit?: number },
    ack: (r: Ack<{ messages: MessageDto[]; hasMore: boolean }>) => void,
  ) => void;

  'typing:start': (p: { channelId: Uuid }) => void;
  'typing:stop': (p: { channelId: Uuid }) => void;

  'presence:set': (
    p: { status: PresenceStatus; customText?: string; customEmoji?: string; until?: string },
    ack: (r: Ack<EmptyPayload>) => void,
  ) => void;

  heartbeat: (p: { ts: number }, ack: (r: { serverTs: number }) => void) => void;
}

// ---------------------------------------------------------------------------
//  Sunucu → İstemci
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  'message:new': (m: MessageDto) => void;
  'message:updated': (p: { channelId: Uuid; seq: number; body: string; editedAt: string }) => void;
  'message:deleted': (p: { channelId: Uuid; seq: number; deletedAt: string; deletedBy: Uuid }) => void;

  /** DLP mesajı engelledi — YALNIZCA gönderene gider, kanala yayınlanmaz. */
  'message:blocked': (p: { clientMsgId: Uuid; channelId: Uuid; reason: string; ruleKeys: string[] }) => void;

  'message:receipt': (p: { channelId: Uuid; userId: Uuid; lastReadSeq: number }) => void;

  /** Arka plandaki kanallar için hafif okunmamış sayacı — mesaj gövdesi taşımaz. */
  'channel:badge': (p: { channelId: Uuid; unread: number; lastSeq: number }) => void;
  'channel:created': (p: { channelId: Uuid; type: ChannelType; name: string | null }) => void;
  'channel:member_added': (p: { channelId: Uuid; userId: Uuid; role: ChannelMemberRole }) => void;
  'channel:member_removed': (p: { channelId: Uuid; userId: Uuid }) => void;

  'typing:update': (p: { channelId: Uuid; userIds: Uuid[] }) => void;
  'presence:update': (p: PresenceDto) => void;

  /** Rol değişimi / oturum sonlandırma → istemci token'ları atar ve çıkış yapar. */
  'session:revoked': (p: { reason: string }) => void;

  error: (p: { code: WsErrorCode; message: string; correlationId: string }) => void;
}

/** Socket'e bağlantı sırasında iliştirilen kimlik. Handshake'ten sonra değişmez. */
export interface SocketAuthContext {
  userId: Uuid;
  orgId: Uuid;
  sessionId: Uuid;
  roles: GlobalRole[];
  permissions: string[];
  tokenVersion: number;
  /** Access token'ın süresinin dolduğu an (epoch ms). Gateway bunu izler. */
  expiresAt: number;
}
