import makeWASocket, {
  Browsers, DisconnectReason, extractMessageContent, isJidGroup, jidNormalizedUser,
  useMultiFileAuthState, type WAMessage, type WAMessageKey, type WAMessageUpdate, type WASocket,
} from 'baileys';
import { rm } from 'node:fs/promises';
import { deleteIncomingMessage, type IncomingMessage } from '../core/ingest.js';
import type { ConnectorFactory } from './types.js';

function messageText(m: WAMessage): string {
  const c = extractMessageContent(m.message);
  if (!c) return '';
  return c.conversation
    ?? c.extendedTextMessage?.text
    ?? c.imageMessage?.caption
    ?? c.videoMessage?.caption
    ?? (c.documentMessage ? [c.documentMessage.fileName, c.documentMessage.caption].filter(Boolean).join(' — ') : null)
    ?? c.pollCreationMessageV3?.name ?? c.pollCreationMessage?.name
    ?? (c.locationMessage ? `[Konum] ${c.locationMessage.name ?? ''} ${c.locationMessage.address ?? ''}`.trim() : null)
    ?? (c.contactMessage ? `[Kişi] ${c.contactMessage.displayName ?? ''}` : null)
    ?? '';
}

export function whatsappToIncoming(
  m: WAMessage, names: { chat?: string | null; self?: string | null } = {},
): IncomingMessage | null {
  const jid = m.key.remoteJid;
  if (!jid || !m.key.id || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return null;
  const body = messageText(m);
  if (!body.trim()) return null;
  const group = Boolean(isJidGroup(jid));
  const fromMe = Boolean(m.key.fromMe);
  const sender = fromMe ? null : group ? m.key.participant ?? null : jid;
  const ts = typeof m.messageTimestamp === 'number' ? m.messageTimestamp : Number(m.messageTimestamp ?? 0);
  return {
    conversation: {
      externalId: jidNormalizedUser(jid),
      kind: group ? 'group' : 'dm',
      title: names.chat ?? (group ? null : m.pushName && !fromMe ? m.pushName : null),
    },
    externalId: m.key.id,
    senderExternalId: sender ? jidNormalizedUser(sender) : null,
    senderName: fromMe ? names.self ?? 'Ben' : m.pushName ?? null,
    fromMe,
    sentAt: ts ? new Date(ts * 1000) : new Date(),
    body,
    raw: { key: m.key, pushName: m.pushName, messageTimestamp: ts },
  };
}

/** WAMessageStubType.REVOKE ("bu mesaj silindi"). */
const STUB_REVOKE = 1;

export type WhatsappUpdate =
  | { type: 'delete'; conversation: string; messageId: string }
  | { type: 'edit'; message: IncomingMessage };

/**
 * Baileys düzenleme ve silmeleri `messages.update` olarak bildirir: silme `messageStubType = REVOKE`,
 * düzenleme `message.editedMessage.message`. Diğer güncellemeler (okundu, tepki vb.) null döner.
 */
export function whatsappUpdateToAction(u: WAMessageUpdate, names: { chat?: string | null; self?: string | null } = {}): WhatsappUpdate | null {
  const jid = u.key.remoteJid;
  if (!jid || !u.key.id) return null;
  if (u.update.messageStubType === STUB_REVOKE) {
    return { type: 'delete', conversation: jidNormalizedUser(jid), messageId: u.key.id };
  }
  const edited = u.update.message?.editedMessage?.message;
  if (!edited) return null;
  const incoming = whatsappToIncoming(
    { key: u.key, message: edited, messageTimestamp: u.update.messageTimestamp } as WAMessage, names);
  return incoming ? { type: 'edit', message: { ...incoming, edit: true } } : null;
}

/**
 * Kullanıcının kendi WhatsApp hesabını "Bağlı cihaz" olarak ekler (WhatsApp Web ile aynı yöntem).
 * Eşleştirme QR'ı pairingQr() ile alınır; oturum dataDir'de saklanır.
 * Yalnız hesap sahibi rıza verdikten sonra başlar (ConnectorManager denetler); ne toplanacağı
 * ingest katmanında consent_scope'a göre süzülür.
 * Resmî olmayan bir protokol istemcisidir: WhatsApp hesabı kısıtlayabilir.
 */
export const whatsappConnector: ConnectorFactory = (ctx) => {
  let sock: WASocket | null = null;
  let qr: string | null = null;
  let stopped = false;
  const groupNames = new Map<string, string | null>();
  const chatNames = new Map<string, string>();

  const groupName = async (jid: string) => {
    if (!groupNames.has(jid)) {
      const meta = await sock?.groupMetadata(jid).catch(() => null);
      groupNames.set(jid, meta?.subject ?? null);
    }
    return groupNames.get(jid) ?? null;
  };

  const handle = async (messages: WAMessage[]) => {
    const self = sock?.user?.name ?? null;
    for (const m of messages) {
      const jid = m.key.remoteJid;
      if (!jid) continue;
      const chat = isJidGroup(jid) ? await groupName(jid) : chatNames.get(jidNormalizedUser(jid)) ?? null;
      const incoming = whatsappToIncoming(m, { chat, self });
      if (incoming) {
        await ctx.ingest(incoming).catch((err) => ctx.log.error({ err }, 'whatsapp mesajı kaydedilemedi'));
      }
    }
  };

  const connect = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(ctx.dataDir);
    sock = makeWASocket({
      auth: state,
      browser: Browsers.appropriate('Incompany'),
      syncFullHistory: ctx.account.consent_scope?.history === true,
      markOnlineOnConnect: false,
      logger: ctx.log.child({ module: 'baileys' }, { level: 'warn' }) as any,
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        qr = u.qr;
        await ctx.setStatus('awaiting_qr');
      }
      if (u.connection === 'open') {
        qr = null;
        await ctx.setStatus('connected', sock?.user?.id ?? null);
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          // Telefon tarafından çıkış yapıldı: eski anahtarlar geçersiz, yeni QR gerekecek.
          await rm(ctx.dataDir, { recursive: true, force: true });
          await ctx.setStatus('logged_out', 'Telefondan bağlantı kaldırıldı; yeniden eşleştirin');
          if (!stopped) setTimeout(() => void connect(), 1000);
        } else if (!stopped) {
          await ctx.setStatus('reconnecting', String(code ?? ''));
          setTimeout(() => void connect(), 3000);
        }
      }
    });
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) if (c.id && (c.name || c.notify)) chatNames.set(jidNormalizedUser(c.id), (c.name ?? c.notify)!);
    });
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
      for (const c of contacts) if (c.id && (c.name || c.notify)) chatNames.set(jidNormalizedUser(c.id), (c.name ?? c.notify)!);
      for (const c of chats) if (c.id && c.name) chatNames.set(jidNormalizedUser(c.id), c.name);
      await handle(messages);
    });
    sock.ev.on('messages.upsert', ({ messages }) => handle(messages));
    sock.ev.on('messages.update', async (updates) => {
      for (const u of updates) {
        try {
          const jid = u.key.remoteJid;
          const chat = jid ? (isJidGroup(jid) ? await groupName(jid) : chatNames.get(jidNormalizedUser(jid)) ?? null) : null;
          const action = whatsappUpdateToAction(u, { chat, self: sock?.user?.name ?? null });
          if (action?.type === 'delete') await deleteIncomingMessage(ctx.db, ctx.account.id, action.conversation, action.messageId);
          if (action?.type === 'edit') await ctx.ingest(action.message);
        } catch (err) {
          ctx.log.error({ err }, 'whatsapp mesaj güncellemesi işlenemedi');
        }
      }
    });
    sock.ev.on('messages.delete', async (d) => {
      if (!('keys' in d)) return;
      for (const k of d.keys as WAMessageKey[]) {
        if (!k.remoteJid || !k.id) continue;
        await deleteIncomingMessage(ctx.db, ctx.account.id, jidNormalizedUser(k.remoteJid), k.id)
          .catch((err) => ctx.log.error({ err }, 'whatsapp mesaj silme işlenemedi'));
      }
    });
  };

  return {
    async start() {
      stopped = false;
      await connect();
    },
    async stop() {
      stopped = true;
      sock?.end(undefined);
      sock = null;
    },
    pairingQr: () => qr,
  };
};
