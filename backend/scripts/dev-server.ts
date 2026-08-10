/* eslint-disable no-console */
/**
 * =============================================================================
 *  iNCompany — DEMO SUNUCUSU
 * =============================================================================
 *
 *  ⚠ BU BİR ÜRETİM SUNUCUSU DEĞİLDİR. Yalnızca `npm run demo` ile çalışır ve
 *    üretim derlemesine (`nest build`, `dist/`) DAHİL EDİLMEZ.
 *
 *  NE İÇİN VAR?
 *    Docker/PostgreSQL/Redis kurulumu olmadan arayüzü çalışır halde görmek.
 *
 *  NE GERÇEK, NE DEĞİL?
 *
 *    GERÇEK (üretim kodunun ta kendisi):
 *      · CryptoService       — AES-256-GCM zarf şifreleme, AAD bağlama
 *      · DlpService          — iki aşamalı eşleştirme, TCKN/Luhn/IBAN doğrulama
 *      · sanitizeRichText    — XSS, bidi override, sıfır genişlikli karakter
 *      · Event sözleşmesi    — @incompany/contracts, frontend ile aynı dosya
 *      · seq semantiği       — kanal içi monotonik sayaç, boşluk tespiti
 *
 *    SAHTE (yalnızca burada):
 *      · Depolama            — PostgreSQL yerine JavaScript Map
 *      · Oturum              — SSO yerine sabit bir demo kullanıcısı
 *      · Yetki               — RBAC/kanal politikası atlanır
 *      · Presence/typing     — Redis yerine bellek
 *
 *    Yani: mesajlar GERÇEKTEN şifrelenip çözülüyor ve DLP GERÇEKTEN çalışıyor.
 *    Kalıcılık ve yetkilendirme taklit ediliyor.
 * =============================================================================
 */

import { createServer } from 'node:http';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import {
  MessageKind,
  ChannelType,
  ChannelMemberRole,
  PresenceStatus,
  WsErrorCode,
  GlobalRole,
  type MessageDto,
} from '@incompany/contracts';

import { CryptoService, type CipherEnvelope } from '../src/common/crypto/crypto.service';
import type { KeyManagementService } from '../src/common/crypto/key-management.service';
import type { ChannelKeyRepository } from '../src/common/crypto/channel-key.repository';
import { DlpService, DlpAction } from '../src/dlp/dlp.service';
import type { DlpRuleRepository, DlpIncidentRepository } from '../src/dlp/dlp.repositories';
import { sanitizeRichText, sanitizePlainText } from '../src/chat/sanitize';

const PORT = 3000;

// =============================================================================
//  Bellek içi altyapı taklidi
// =============================================================================

/** KMS taklidi — süreç ömrü boyunca geçerli bir master anahtar. */
const masterKey = randomBytes(32);

const fakeKms: KeyManagementService = {
  async wrapKey(dek: Buffer): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), wrapped]);
  },
  async unwrapKey(wrapped: Buffer): Promise<Buffer> {
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]);
  },
  async healthCheck(): Promise<boolean> {
    return true;
  },
} as KeyManagementService;

/** Kanal anahtarı deposu taklidi. */
const keyStore = new Map<string, Array<{ version: number; wrappedDek: Buffer }>>();

const fakeKeyRepo = {
  async findActive(channelId: string) {
    const versions = keyStore.get(channelId);
    if (!versions) return null;
    const latest = versions[versions.length - 1]!;
    return { channelId, version: latest.version, wrappedDek: latest.wrappedDek } as never;
  },
  async findByVersion(channelId: string, version: number) {
    const found = keyStore.get(channelId)?.find((v) => v.version === version);
    return found ? ({ channelId, version, wrappedDek: found.wrappedDek } as never) : null;
  },
  async insertNewVersion(channelId: string, wrappedDek: Buffer): Promise<number> {
    const versions = keyStore.get(channelId) ?? [];
    const next = (versions[versions.length - 1]?.version ?? 0) + 1;
    versions.push({ version: next, wrappedDek });
    keyStore.set(channelId, versions);
    return next;
  },
} as unknown as ChannelKeyRepository;

/** DLP kural deposu taklidi — boş döner, yerleşik kurallar devreye girer. */
const fakeRuleRepo = { async findAllActive() { return []; } } as unknown as DlpRuleRepository;

const dlpIncidents: Array<{ ruleKey: string; userId: string | null; at: string }> = [];
const fakeIncidentRepo = {
  async create(input: { ruleKey: string; userId: string | null }) {
    dlpIncidents.push({ ...input, at: new Date().toISOString() });
    console.log(`  [DLP] olay kaydi: ${input.ruleKey}`);
  },
} as unknown as DlpIncidentRepository;

const crypto = new CryptoService(fakeKms, fakeKeyRepo);
const dlp = new DlpService(fakeRuleRepo, fakeIncidentRepo);

// =============================================================================
//  Demo verisi
// =============================================================================

const ORG_ID = '00000000-0000-4000-8000-000000000001';

interface DemoUser {
  id: string;
  displayName: string;
  email: string;
  title: string;
  presence: PresenceStatus;
  roles: GlobalRole[];
  status: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED';
  lastLoginAt?: string;
}

const users: DemoUser[] = [
  { id: 'a0000000-0000-4000-8000-000000000001', displayName: 'Elif Aydın', email: 'elif@ornek-sirket.com', title: 'Yazılım Mimarı', presence: PresenceStatus.ONLINE, roles: [GlobalRole.ADMIN], status: 'ACTIVE', lastLoginAt: new Date().toISOString() },
  { id: 'a0000000-0000-4000-8000-000000000002', displayName: 'Ayşe Yılmaz', email: 'ayse@ornek-sirket.com', title: 'Backend Geliştirici', presence: PresenceStatus.ONLINE, roles: [GlobalRole.EMPLOYEE], status: 'ACTIVE' },
  { id: 'a0000000-0000-4000-8000-000000000003', displayName: 'Can Demir', email: 'can@ornek-sirket.com', title: 'İK Uzmanı', presence: PresenceStatus.BUSY, roles: [GlobalRole.DEPT_MANAGER], status: 'ACTIVE' },
  { id: 'a0000000-0000-4000-8000-000000000004', displayName: 'Zeynep Kaya', email: 'zeynep@ornek-sirket.com', title: 'Ürün Yöneticisi', presence: PresenceStatus.AWAY, roles: [GlobalRole.DEPT_MANAGER], status: 'ACTIVE' },
  { id: 'a0000000-0000-4000-8000-000000000005', displayName: 'Emre Şahin', email: 'emre@ornek-sirket.com', title: 'Finans Uzmanı', presence: PresenceStatus.OFFLINE, roles: [GlobalRole.EMPLOYEE], status: 'SUSPENDED' },
  { id: 'a0000000-0000-4000-8000-000000000006', displayName: 'Sistem', email: 'sistem@ornek-sirket.com', title: '', presence: PresenceStatus.OFFLINE, roles: [GlobalRole.EMPLOYEE], status: 'ACTIVE' },
];

/** Kullanıcı tercihleri — gerçek sistemde `users.preferences` JSONB sütunu. */
const userPreferences: Record<string, unknown> = {};

/** Oturum açmış kabul edilen kullanıcı. */
const ME = users[0]!;

interface DemoChannel {
  id: string;
  type: ChannelType;
  name: string | null;
  topic: string | null;
  lastSeq: number;
  peerUserId?: string;
  isPinned: boolean;
  isMuted: boolean;
  readOnly: boolean;
  isE2ee?: boolean;
  /**
   * Üye listesi — DM'ler dahil TÜM kanal türleri için tek kaynak.
   * `memberCount` artık ayrı bir sabit sayı DEĞİLDİR, bu dizinin
   * uzunluğundan türetilir (bkz. serializeChannel) — ikisinin birbirinden
   * ayrışması (ör. sayı 128 gösterip listede 3 kişi olması) gerçek bir
   * üye yönetimi panelinde hemen fark edilirdi.
   */
  members: Array<{ userId: string; role: ChannelMemberRole }>;
}

const OWNER = ChannelMemberRole.OWNER;
const MEMBER = ChannelMemberRole.MEMBER;

const channels: DemoChannel[] = [
  {
    id: 'c0000000-0000-4000-8000-000000000001', type: ChannelType.GROUP, name: 'genel',
    topic: 'Şirket geneli sohbet · herkese açık', lastSeq: 0, isPinned: true, isMuted: false, readOnly: false,
    members: users.filter((u) => u.status === 'ACTIVE').map((u) => ({ userId: u.id, role: u.id === ME.id ? OWNER : MEMBER })),
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002', type: ChannelType.DEPARTMENT, name: 'bt-departmani',
    topic: 'Bilgi Teknolojileri · altyapı ve geliştirme', lastSeq: 0, isPinned: false, isMuted: false, readOnly: false,
    members: [
      { userId: users[0]!.id, role: OWNER },
      { userId: users[1]!.id, role: MEMBER },
    ],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000003', type: ChannelType.ANNOUNCEMENT, name: 'duyurular',
    topic: 'Kurumsal duyurular', lastSeq: 0, isPinned: false, isMuted: false, readOnly: true,
    members: users.filter((u) => u.status === 'ACTIVE').map((u) => ({ userId: u.id, role: u.id === ME.id ? OWNER : MEMBER })),
  },
  {
    id: 'c0000000-0000-4000-8000-000000000006', type: ChannelType.GROUP, name: 'hukuk-gizli',
    topic: 'Uçtan uca şifreli · aranamaz, arşivlenemez', lastSeq: 0, isPinned: false, isMuted: false, readOnly: false, isE2ee: true,
    members: [
      { userId: users[0]!.id, role: OWNER },
      { userId: users[2]!.id, role: MEMBER },
    ],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000004', type: ChannelType.DM, name: null, topic: null, lastSeq: 0,
    peerUserId: users[1]!.id, isPinned: false, isMuted: false, readOnly: false,
    members: [{ userId: ME.id, role: MEMBER }, { userId: users[1]!.id, role: MEMBER }],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000005', type: ChannelType.DM, name: null, topic: null, lastSeq: 0,
    peerUserId: users[2]!.id, isPinned: false, isMuted: true, readOnly: false,
    members: [{ userId: ME.id, role: MEMBER }, { userId: users[2]!.id, role: MEMBER }],
  },
];

/** Şifreli mesaj deposu — düz metin BURADA TUTULMAZ, tıpkı üretimdeki gibi. */
interface StoredMessage {
  id: string;
  channelId: string;
  seq: number;
  senderId: string | null;
  kind: MessageKind;
  clientMsgId: string;
  envelope: CipherEnvelope;
  replyToSeq?: number;
  dlpMasked: boolean;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  deletedBy?: string;
}

const messages = new Map<string, StoredMessage[]>();
const readCursors = new Map<string, number>();

/** Kanal içi monotonik sıra — üretimdeki `next_channel_seq()` karşılığı. */
function nextSeq(channel: DemoChannel): number {
  channel.lastSeq += 1;
  return channel.lastSeq;
}

async function ensureChannelKey(channelId: string): Promise<void> {
  if (keyStore.has(channelId)) return;
  const dek = randomBytes(32);
  keyStore.set(channelId, [{ version: 1, wrappedDek: await fakeKms.wrapKey(dek) }]);
  dek.fill(0);
}

async function storeMessage(
  channelId: string,
  senderId: string | null,
  body: string,
  clientMsgId: string,
  replyToSeq?: number,
): Promise<{ stored: StoredMessage; plaintext: string; dlpMasked: boolean; blocked?: string[] }> {
  const channel = channels.find((c) => c.id === channelId)!;
  await ensureChannelKey(channelId);

  // --- GERÇEK ÜRETİM SIRASI: sanitize → DLP → şifreleme → kalıcılık ---
  const sanitized = sanitizeRichText(body);

  const scan = await dlp.scan(sanitized, {
    orgId: ORG_ID,
    userId: senderId ?? ME.id,
    channelId,
    channelType: channel.type,
    isE2ee: false,
  });

  if (scan.action === DlpAction.BLOCK) {
    return {
      stored: null as never,
      plaintext: '',
      dlpMasked: false,
      blocked: scan.matches.map((m) => m.ruleKey),
    };
  }

  const messageId = randomUUID();
  const seq = nextSeq(channel);
  const envelope = await crypto.encryptMessage(channelId, messageId, scan.body);

  const stored: StoredMessage = {
    id: messageId,
    channelId,
    seq,
    senderId,
    kind: MessageKind.TEXT,
    clientMsgId,
    envelope,
    replyToSeq,
    dlpMasked: scan.action === DlpAction.MASK,
    createdAt: new Date().toISOString(),
  };

  const list = messages.get(channelId) ?? [];
  list.push(stored);
  messages.set(channelId, list);

  return { stored, plaintext: scan.body, dlpMasked: stored.dlpMasked };
}

/**
 * Mesaj düzenler — sanitize ve DLP taraması YENİDEN uygulanır.
 *
 * Bu, gerçek `ChatService.editMessage` ile aynı ilkeyi taşır: düzenleme,
 * gönderimin DLP taramasını atlatan ikinci bir yol OLMAMALIDIR. Bir kullanıcı
 * temiz bir mesaj gönderip ardından düzenleyerek hassas veri ekleyemez.
 */
async function editStoredMessage(
  channelId: string,
  seq: number,
  requesterId: string,
  newBody: string,
): Promise<{ ok: true; stored: StoredMessage; dlpMasked: boolean } | { ok: false; reason: string; blocked?: string[] }> {
  const list = messages.get(channelId) ?? [];
  const stored = list.find((m) => m.seq === seq);

  if (!stored || stored.deletedAt) return { ok: false, reason: 'Mesaj bulunamadı' };
  // Yalnızca kendi mesajın düzenlenebilir — moderatör bile başkasının
  // sözünü değiştiremez, yalnızca silebilir.
  if (stored.senderId !== requesterId) return { ok: false, reason: 'Yalnızca kendi mesajlarınızı düzenleyebilirsiniz' };

  const channel = channels.find((c) => c.id === channelId)!;
  const sanitized = sanitizeRichText(newBody);

  const scan = await dlp.scan(sanitized, {
    orgId: ORG_ID,
    userId: requesterId,
    channelId,
    channelType: channel.type,
    isE2ee: false,
  });

  if (scan.action === DlpAction.BLOCK) {
    return { ok: false, reason: 'Düzenleme hassas veri içerdiği için reddedildi', blocked: scan.matches.map((m) => m.ruleKey) };
  }

  // AAD `messageId`'ye bağlıdır ve messageId değişmez — aynı bağlamla
  // yeniden şifrelenir (bkz. CryptoService).
  stored.envelope = await crypto.encryptMessage(channelId, stored.id, scan.body);
  stored.dlpMasked = scan.action === DlpAction.MASK;
  stored.editedAt = new Date().toISOString();

  return { ok: true, stored, dlpMasked: stored.dlpMasked };
}

function deleteStoredMessage(
  channelId: string,
  seq: number,
  requesterId: string,
): { ok: true; deletedAt: string } | { ok: false; reason: string } {
  const list = messages.get(channelId) ?? [];
  const stored = list.find((m) => m.seq === seq);

  if (!stored || stored.deletedAt) return { ok: false, reason: 'Mesaj bulunamadı' };

  // Yetki: kendi mesajı VEYA kanal sahibi/moderatörü. Gerçek backend'de bu
  // karar `ChannelPolicyService.canDeleteMessage`'dadır; burada aynı kural
  // basitleştirilmiş biçimde tekrarlanır.
  const membership = channels.find((c) => c.id === channelId)?.members.find((m) => m.userId === requesterId);
  const isStaff = membership?.role === ChannelMemberRole.OWNER || membership?.role === ChannelMemberRole.MODERATOR;

  if (stored.senderId !== requesterId && !isStaff) {
    return { ok: false, reason: 'Bu mesajı silme yetkiniz yok' };
  }

  stored.deletedAt = new Date().toISOString();
  stored.deletedBy = requesterId;
  return { ok: true, deletedAt: stored.deletedAt };
}

/** Şifreli kaydı istemciye gidecek DTO'ya çevirir — gerçekten çözerek. */
async function toDto(stored: StoredMessage): Promise<MessageDto> {
  let body = '';
  try {
    body = stored.deletedAt
      ? ''
      : await crypto.decryptMessage(stored.channelId, stored.id, stored.envelope);
  } catch {
    body = '[Bu mesaj cozulemedi]';
  }

  return {
    id: stored.id,
    channelId: stored.channelId,
    seq: stored.seq,
    senderId: stored.senderId,
    kind: stored.kind,
    body,
    clientMsgId: stored.clientMsgId,
    replyToSeq: stored.replyToSeq,
    mentions: [],
    attachments: [],
    dlpMasked: stored.dlpMasked || undefined,
    editedAt: stored.editedAt,
    deletedAt: stored.deletedAt,
    createdAt: stored.createdAt,
  };
}

// =============================================================================
//  HTTP API
// =============================================================================

const app = express();
app.use(express.json());

app.post('/api/v1/auth/refresh', (_req, res) => {
  res.json({ accessToken: 'demo-token', expiresAt: Date.now() + 60 * 60 * 1000 });
});

app.get('/api/v1/auth/me', (_req, res) => {
  res.json({
    id: ME.id,
    orgId: ORG_ID,
    email: ME.email,
    displayName: ME.displayName,
    roles: [GlobalRole.ADMIN],
    permissions: [
      'channel.create', 'channel.member.manage', 'channel.archive',
      'announcement.post', 'message.delete.any',
      'audit.read', 'dlp.manage', 'user.manage', 'role.assign',
    ],
    sessionId: randomUUID(),
  });
});

app.post('/api/v1/auth/logout', (_req, res) => res.status(204).end());

app.get('/api/v1/channels', (_req, res) => {
  res.json({
    channels: channels.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      topic: c.topic,
      unreadCount: Math.max(c.lastSeq - (readCursors.get(c.id) ?? 0), 0),
      isPinned: c.isPinned,
      isMuted: c.isMuted,
      peerUserId: c.peerUserId,
      // `memberCount` DAİMA `members` dizisinin uzunluğundan türetilir —
      // ayrı bir sabit sayı olsaydı, üye ekleme/çıkarma sonrası rozet ile
      // gerçek liste birbirinden sessizce ayrışırdı.
      memberCount: c.type === ChannelType.DM ? undefined : c.members.length,
      isE2ee: c.isE2ee,
      isReadOnly: c.readOnly,
    })),
  });
});

app.get('/api/v1/channels/:id/members', (req, res) => {
  const channel = channels.find((c) => c.id === req.params.id);
  if (!channel) {
    res.status(404).json({ message: 'Kanal bulunamadı' });
    return;
  }
  // Üyelik doğrulaması: kanalın üyesi olmayan biri listeyi göremez —
  // gerçek backend'deki `ChannelService.listMembers` ile aynı kural.
  if (!channel.members.some((m) => m.userId === ME.id)) {
    res.status(403).json({ message: 'Bu kanalin uyesi degilsiniz' });
    return;
  }

  const enriched = channel.members
    .map((m) => {
      const profile = users.find((u) => u.id === m.userId);
      if (!profile) return null;
      return {
        userId: profile.id,
        displayName: profile.displayName,
        email: profile.email,
        title: profile.title || null,
        role: m.role,
        joinedAt: new Date().toISOString(),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    // Sahip/moderatör üstte, sonra ada göre — gerçek backend sorgusuyla aynı sıra.
    .sort((a, b) => {
      const rank = (r: ChannelMemberRole): number => (r === ChannelMemberRole.OWNER ? 0 : r === ChannelMemberRole.MODERATOR ? 1 : 2);
      return rank(a.role) - rank(b.role) || a.displayName.localeCompare(b.displayName, 'tr-TR');
    });

  res.json({ members: enriched });
});

app.post('/api/v1/channels/:id/members', (req, res) => {
  const channel = channels.find((c) => c.id === req.params.id);
  if (!channel) {
    res.status(404).json({ message: 'Kanal bulunamadı' });
    return;
  }

  const userIds: string[] = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  const existing = new Set(channel.members.map((m) => m.userId));
  let added = 0;

  for (const userId of userIds) {
    if (existing.has(userId)) continue;
    if (!users.some((u) => u.id === userId)) continue;
    channel.members.push({ userId, role: ChannelMemberRole.MEMBER });
    existing.add(userId);
    added += 1;
  }

  console.log(`  [ÜYE] ${added} kişi #${channel.name ?? channel.id} kanalına eklendi`);
  res.json({ added });
});

app.delete('/api/v1/channels/:id/members/:userId', (req, res) => {
  const channel = channels.find((c) => c.id === req.params.id);
  if (!channel) {
    res.status(404).json({ message: 'Kanal bulunamadı' });
    return;
  }

  const before = channel.members.length;
  // Sahip (OWNER) çıkarılamaz — gerçek backend'de bu, ChannelMembersDialog'un
  // arayüzden zaten gizlediği bir durumdur; sunucu tarafında da tekrarlanır.
  channel.members = channel.members.filter(
    (m) => !(m.userId === req.params.userId && m.role !== ChannelMemberRole.OWNER),
  );

  if (channel.members.length === before) {
    res.status(403).json({ message: 'Bu üye çıkarılamaz' });
    return;
  }

  res.status(204).end();
});

app.post('/api/v1/users/resolve', (req, res) => {
  const ids: string[] = req.body?.userIds ?? [];
  res.json({ users: users.filter((u) => ids.includes(u.id)) });
});

/** Dizin — DM başlatma seçicisi kullanır. */
app.get('/api/v1/users', (_req, res) => {
  res.json({
    users: users
      .filter((u) => u.status === 'ACTIVE')
      .map(({ id, displayName, email, title }) => ({ id, displayName, email, title })),
  });
});

app.patch('/api/v1/users/me', (req, res) => {
  if (typeof req.body?.displayName === 'string') {
    ME.displayName = sanitizePlainText(req.body.displayName, 80) || ME.displayName;
  }
  if (typeof req.body?.title === 'string') {
    ME.title = sanitizePlainText(req.body.title, 60);
  }
  res.json({ id: ME.id, displayName: ME.displayName, title: ME.title });
});

app.patch('/api/v1/users/me/preferences', (req, res) => {
  Object.assign(userPreferences, req.body ?? {});
  res.json(userPreferences);
});

app.get('/api/v1/auth/sessions', (_req, res) => {
  res.json({
    sessions: [
      {
        id: randomUUID(),
        deviceLabel: 'Chrome · Windows',
        ipAddress: '127.0.0.1',
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ],
  });
});

// --- Yönetim ----------------------------------------------------------------

app.get('/api/v1/admin/users', (_req, res) => {
  res.json({
    users: users.map((u) => ({
      id: u.id,
      displayName: u.displayName,
      email: u.email,
      title: u.title,
      roles: u.roles,
      status: u.status,
      lastLoginAt: u.lastLoginAt,
    })),
  });
});

app.post('/api/v1/admin/users', (req, res) => {
  const { displayName, email, title, roles } = req.body ?? {};

  if (typeof displayName !== 'string' || typeof email !== 'string') {
    res.status(400).json({ message: 'displayName ve email zorunlu' });
    return;
  }
  // Gerçek uygulamada bu kısıt veritabanındaki UNIQUE(org_id, email)
  // indeksiyle zorlanır; burada elle kontrol ediliyor.
  if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    res.status(409).json({ message: 'Bu e-posta zaten kayıtlı' });
    return;
  }

  const created: DemoUser = {
    id: randomUUID(),
    displayName: sanitizePlainText(displayName, 80),
    email: email.toLowerCase(),
    title: typeof title === 'string' ? sanitizePlainText(title, 60) : '',
    presence: PresenceStatus.OFFLINE,
    roles: Array.isArray(roles) && roles.length > 0 ? roles : [GlobalRole.EMPLOYEE],
    status: 'ACTIVE',
  };

  users.push(created);
  console.log(`  [ADMIN] kullanici olusturuldu: ${created.email}`);
  res.status(201).json(created);
});

app.patch('/api/v1/admin/users/:id', (req, res) => {
  const user = users.find((u) => u.id === req.params.id);
  if (!user) {
    res.status(404).json({ message: 'Kullanıcı bulunamadı' });
    return;
  }

  if (Array.isArray(req.body?.roles)) {
    user.roles = req.body.roles;
    // Gerçek sistemde bu, `token_version` artırımını tetikler ve
    // kullanıcının TÜM oturumları anında sonlanır.
    console.log(`  [ADMIN] rol degisti: ${user.email} → ${user.roles.join(', ')}`);
  }
  if (typeof req.body?.status === 'string') {
    user.status = req.body.status;
    console.log(`  [ADMIN] durum degisti: ${user.email} → ${user.status}`);
  }

  res.json(user);
});

// --- Kanal oluşturma --------------------------------------------------------

app.post('/api/v1/channels', async (req, res) => {
  const { type, name, topic, e2eeEnabled } = req.body ?? {};

  const cleanName = sanitizePlainText(String(name ?? ''), 80);
  if (cleanName.length < 2) {
    res.status(400).json({ message: 'Kanal adı en az 2 karakter olmalı' });
    return;
  }
  if (channels.some((c) => c.name?.toLowerCase() === cleanName.toLowerCase())) {
    res.status(409).json({ message: 'Bu isimde bir kanal zaten var' });
    return;
  }

  const created: DemoChannel = {
    id: randomUUID(),
    type: type ?? ChannelType.GROUP,
    name: cleanName,
    topic: topic ? sanitizePlainText(String(topic), 250) : null,
    lastSeq: 0,
    isPinned: false,
    isMuted: false,
    readOnly: type === ChannelType.ANNOUNCEMENT,
    isE2ee: Boolean(e2eeEnabled),
    // Oluşturan kişi otomatik olarak OWNER üye olur.
    members: [{ userId: ME.id, role: ChannelMemberRole.OWNER }],
  };

  channels.push(created);
  await ensureChannelKey(created.id);

  console.log(`  [KANAL] olusturuldu: #${created.name}${created.isE2ee ? ' (E2EE)' : ''}`);
  res.status(201).json(created);
});

app.post('/api/v1/channels/dm/:userId', async (req, res) => {
  const target = users.find((u) => u.id === req.params.userId);
  if (!target) {
    res.status(404).json({ message: 'Kullanıcı bulunamadı' });
    return;
  }

  // İdempotent: aynı kişiyle ikinci bir DM açılmaz, mevcut olan döner.
  // Gerçek şemada bunu `dm_key` üzerindeki benzersiz indeks garanti eder.
  const existing = channels.find(
    (c) => c.type === ChannelType.DM && c.peerUserId === target.id,
  );
  if (existing) {
    res.json(existing);
    return;
  }

  const created: DemoChannel = {
    id: randomUUID(),
    type: ChannelType.DM,
    name: null,
    topic: null,
    lastSeq: 0,
    peerUserId: target.id,
    isPinned: false,
    isMuted: false,
    readOnly: false,
    members: [
      { userId: ME.id, role: ChannelMemberRole.MEMBER },
      { userId: target.id, role: ChannelMemberRole.MEMBER },
    ],
  };

  channels.push(created);
  await ensureChannelKey(created.id);
  res.status(201).json(created);
});

app.get('/api/v1/channels/:channelId/messages', async (req, res) => {
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = Math.min(Number(req.query.limit ?? 50), 100);

  const all = messages.get(req.params.channelId) ?? [];
  const filtered = before ? all.filter((m) => m.seq < before) : all;
  const page = filtered.slice(-limit);

  res.json({
    messages: await Promise.all(page.map(toDto)),
    hasMore: filtered.length > page.length,
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'demo' }));

// =============================================================================
//  WebSocket
// =============================================================================

const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  // `path` VARSAYILANDA BIRAKILIR (`/socket.io`).
  //
  // İstemci `io('http://localhost:3000/ws')` çağırır; socket.io-client bunu
  // "host=localhost:3000, NAMESPACE=/ws, path=/socket.io" olarak ayrıştırır.
  // `/ws` bir yol değil, bir isim alanıdır. Buraya `path: '/ws/...'` yazmak
  // el sıkışmayı sessizce 404'e düşürür — NestJS gateway'i de aynı şekilde
  // `namespace: '/ws'` kullanır.
  cors: { origin: ['http://localhost:5173'], credentials: true },
  transports: ['websocket'],
});

const nsp = io.of('/ws');
const typingByChannel = new Map<string, Set<string>>();

nsp.on('connection', (socket) => {
  console.log(`  [WS] baglandi: ${socket.id}`);
  socket.data.userId = ME.id;

  void socket.join(`u:${ME.id}`);
  void socket.join(`o:${ORG_ID}`);

  // Demo kullanıcılarının varlık durumunu yayınla.
  for (const user of users) {
    socket.emit('presence:update', {
      userId: user.id,
      status: user.presence,
      lastSeenAt: new Date().toISOString(),
    });
  }

  socket.on('channel:subscribe', async ({ channelIds }, ack) => {
    for (const id of channelIds) await socket.join(`c:${id}`);
    ack?.({ ok: true, joined: channelIds, denied: [], correlationId: randomUUID() });
  });

  socket.on('channel:unsubscribe', async ({ channelIds }, ack) => {
    for (const id of channelIds) await socket.leave(`c:${id}`);
    ack?.({ ok: true, correlationId: randomUUID() });
  });

  socket.on('message:send', async (payload, ack) => {
    const correlationId = randomUUID();

    try {
      const result = await storeMessage(
        payload.channelId,
        ME.id,
        payload.body,
        payload.clientMsgId,
        payload.replyToSeq,
      );

      // --- DLP ENGELİ (gerçek motor) ---
      if (result.blocked) {
        console.log(`  [DLP] ENGELLENDI: ${result.blocked.join(', ')}`);
        socket.emit('message:blocked', {
          clientMsgId: payload.clientMsgId,
          channelId: payload.channelId,
          reason: 'Mesaj hassas veri icerdigi icin gonderilemedi',
          ruleKeys: result.blocked,
        });
        ack?.({
          ok: false,
          code: WsErrorCode.DLP_BLOCKED,
          message: 'Mesaj hassas veri icerdigi icin gonderilemedi',
          correlationId,
        });
        return;
      }

      const dto = await toDto(result.stored);
      if (result.dlpMasked) console.log('  [DLP] maskelendi');

      nsp.to(`c:${payload.channelId}`).emit('message:new', dto);

      ack?.({
        ok: true,
        messageId: dto.id,
        seq: dto.seq,
        serverTs: dto.createdAt,
        dlpMasked: result.dlpMasked,
        correlationId,
      });

      // Demoyu canlı hissettirmek için otomatik yanıt.
      scheduleAutoReply(payload.channelId);
    } catch (error) {
      console.error('  [WS] gonderim hatasi:', (error as Error).message);
      ack?.({ ok: false, code: WsErrorCode.INTERNAL, message: 'Hata', correlationId });
    }
  });

  socket.on('message:read', ({ channelId, upToSeq }, ack) => {
    readCursors.set(channelId, Math.max(readCursors.get(channelId) ?? 0, upToSeq));
    ack?.({ ok: true, unread: 0, correlationId: randomUUID() });
  });

  socket.on('message:edit', async ({ channelId, seq, body }, ack) => {
    const correlationId = randomUUID();
    const result = await editStoredMessage(channelId, seq, ME.id, body);

    if (!result.ok) {
      if (result.blocked) {
        socket.emit('message:blocked', {
          clientMsgId: '',
          channelId,
          reason: result.reason,
          ruleKeys: result.blocked,
        });
      }
      ack?.({ ok: false, code: WsErrorCode.DLP_BLOCKED, message: result.reason, correlationId });
      return;
    }

    const dto = await toDto(result.stored);
    nsp.to(`c:${channelId}`).emit('message:updated', {
      channelId,
      seq,
      body: dto.body,
      editedAt: dto.editedAt!,
    });

    ack?.({ ok: true, editedAt: dto.editedAt!, correlationId });
  });

  socket.on('message:delete', (dto, ack) => {
    const correlationId = randomUUID();
    const result = deleteStoredMessage(dto.channelId, dto.seq, ME.id);

    if (!result.ok) {
      ack?.({ ok: false, code: WsErrorCode.FORBIDDEN, message: result.reason, correlationId });
      return;
    }

    nsp.to(`c:${dto.channelId}`).emit('message:deleted', {
      channelId: dto.channelId,
      seq: dto.seq,
      deletedAt: result.deletedAt,
      deletedBy: ME.id,
    });

    ack?.({ ok: true, correlationId });
  });

  socket.on('channel:sync', async ({ channelId, sinceSeq }, ack) => {
    const all = messages.get(channelId) ?? [];
    const missing = all.filter((m) => m.seq > sinceSeq);
    ack?.({
      ok: true,
      messages: await Promise.all(missing.map(toDto)),
      hasMore: false,
      correlationId: randomUUID(),
    });
  });

  socket.on('typing:start', ({ channelId }) => {
    const set = typingByChannel.get(channelId) ?? new Set();
    set.add(ME.id);
    typingByChannel.set(channelId, set);
  });

  socket.on('typing:stop', ({ channelId }) => {
    typingByChannel.get(channelId)?.delete(ME.id);
  });

  socket.on('presence:set', ({ status }, ack) => {
    ME.presence = status;
    nsp.to(`o:${ORG_ID}`).emit('presence:update', {
      userId: ME.id,
      status,
      lastSeenAt: new Date().toISOString(),
    });
    ack?.({ ok: true, correlationId: randomUUID() });
  });

  socket.on('heartbeat', (_p, ack) => ack?.({ serverTs: Date.now() }));

  socket.on('disconnect', () => console.log(`  [WS] koptu: ${socket.id}`));
});

/** Mesaj gönderince karşı tarafın "yazıyor…" gösterip yanıt vermesi. */
const AUTO_REPLIES = [
  'Anlaşıldı, bakıyorum.',
  'Teşekkürler, hemen dönüş yapacağım.',
  'Bu konuyu toplantıda konuşalım mı?',
  'Şu an müsait değilim, birazdan yazarım.',
  '`docker compose up` çalıştırdım, sorun çözüldü.',
];

let autoReplyPending = false;

function scheduleAutoReply(channelId: string): void {
  if (autoReplyPending) return;
  autoReplyPending = true;

  const responder = users[1 + Math.floor(Math.random() * 3)]!;

  setTimeout(() => {
    nsp.to(`c:${channelId}`).emit('typing:update', { channelId, userIds: [responder.id] });
  }, 600);

  setTimeout(async () => {
    nsp.to(`c:${channelId}`).emit('typing:update', { channelId, userIds: [] });

    const body = AUTO_REPLIES[Math.floor(Math.random() * AUTO_REPLIES.length)]!;
    const result = await storeMessage(channelId, responder.id, body, randomUUID());
    if (result.stored) {
      nsp.to(`c:${channelId}`).emit('message:new', await toDto(result.stored));
    }
    autoReplyPending = false;
  }, 2400);
}

// =============================================================================
//  Başlangıç verisi
// =============================================================================

async function seed(): Promise<void> {
  const seedData: Array<[string, string, string]> = [
    [channels[0]!.id, users[3]!.id, 'Günaydın herkese! Bugünkü sprint planlama 14:00\'te.'],
    [channels[0]!.id, users[1]!.id, 'Katılıyorum. **Realtime gateway** için ölçekleme notlarını hazırladım.'],
    [channels[0]!.id, ME.id, 'Harika. `seq` tabanlı boşluk tespitini de ekleyelim mi?'],
    [channels[0]!.id, users[1]!.id, 'Kesinlikle — zaman damgası sıralama için yetmiyor.'],

    [channels[1]!.id, users[1]!.id, 'PostgreSQL partition stratejisi hazır:\n\n- Aylık `RANGE` partition\n- Retention = `DROP PARTITION`\n- VACUUM baskısı yok'],
    [channels[1]!.id, ME.id, 'Bu doğru yaklaşım. 50M satırlık DELETE saatler sürerdi.'],

    [channels[2]!.id, users[4]!.id, '**Bilgi Güvenliği Duyurusu**\n\nYeni DLP politikası devrede. TCKN, kredi kartı ve API anahtarı içeren mesajlar otomatik olarak maskelenecek veya engellenecektir.\n\nSorularınız için `bt-departmani` kanalını kullanabilirsiniz.'],

    [channels[3]!.id, users[3]!.id, 'Sözleşme taslağı hazır, yarın paylaşacağım.'],

    [channels[4]!.id, users[1]!.id, 'Merhaba, şifreleme servisindeki yarış koşulu düzeldi mi?'],
    [channels[4]!.id, ME.id, 'Evet, tek uçuş (single-flight) garantisi ekledim. Regresyon testi de yazdım.'],
    [channels[4]!.id, users[1]!.id, 'Süper 👏'],

    [channels[5]!.id, users[2]!.id, 'İzin formunu ne zaman gönderebilirsin?'],
  ];

  for (const [channelId, senderId, body] of seedData) {
    await storeMessage(channelId, senderId, body, randomUUID());
  }

  // Bazı kanallarda bilinçli olarak okunmamış bırak — rozetler görünsün.
  readCursors.set(channels[0]!.id, channels[0]!.lastSeq);
  readCursors.set(channels[4]!.id, channels[4]!.lastSeq - 1);
}

// =============================================================================

async function main(): Promise<void> {
  await dlp.onModuleInit();
  await seed();

  httpServer.listen(PORT, () => {
    console.log('');
    console.log('  ╭──────────────────────────────────────────────────────╮');
    console.log('  │  iNCompany DEMO SUNUCUSU                             │');
    console.log('  ├──────────────────────────────────────────────────────┤');
    console.log(`  │  API   : http://localhost:${PORT}/api/v1                │`);
    console.log(`  │  WS    : ws://localhost:${PORT}/ws                      │`);
    console.log('  │                                                      │');
    console.log('  │  GERÇEK: kripto (AES-256-GCM), DLP, sanitize, seq     │');
    console.log('  │  SAHTE : depolama (bellek), oturum, yetkilendirme     │');
    console.log('  ╰──────────────────────────────────────────────────────╯');
    console.log('');
    console.log('  DLP denemesi icin bir mesaja su degerleri yazin:');
    console.log('    TCKN (maskelenir)     : 10000000146');
    console.log('    Kredi karti (ENGEL)   : 4532015112830366');
    console.log('    AWS anahtari (ENGEL)  : AKIAIOSFODNN7EXAMPLE');
    console.log('');
  });
}

void main();
