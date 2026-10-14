import bolt from '@slack/bolt';
import { deleteIncomingMessage, type IncomingMessage } from '../core/ingest.js';
import { groupNotice } from './notice.js';
import type { ConnectorFactory } from './types.js';

export interface SlackMessageEvent {
  channel: string;
  channel_type?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  /** message_changed: düzenlenmiş son hali. */
  message?: Partial<SlackMessageEvent>;
  /** message_deleted: silinen mesajın ts'i. */
  deleted_ts?: string;
}

/** Silinen mesajın (kanal, ts) çifti; silme olayı değilse null. */
export function slackDeletion(e: SlackMessageEvent): { channel: string; ts: string } | null {
  return e.subtype === 'message_deleted' && e.deleted_ts ? { channel: e.channel, ts: e.deleted_ts } : null;
}

export function slackToIncoming(
  e: SlackMessageEvent, names: { channel?: string | null; user?: string | null },
): IncomingMessage | null {
  // Düzenleme: yeni içerik kayıtlı mesajın yerine yazılır.
  if (e.subtype === 'message_changed' && e.message) {
    const incoming = slackToIncoming(
      { ...(e.message as SlackMessageEvent), channel: e.channel, channel_type: e.channel_type }, names);
    return incoming ? { ...incoming, edit: true } : null;
  }
  // Silme/katılım gibi alt tipler hafızaya yazılmaz; dosya paylaşımı metniyle kalır.
  if (e.subtype && e.subtype !== 'file_share' && e.subtype !== 'thread_broadcast') return null;
  const body = e.text ?? '';
  if (!body.trim()) return null;
  const kind = e.channel_type === 'im' ? 'dm' : e.channel_type === 'channel' ? 'channel' : 'group';
  return {
    conversation: { externalId: e.channel, kind, title: names.channel ?? null },
    externalId: e.ts,
    senderExternalId: e.user ?? e.bot_id ?? null,
    senderName: names.user ?? null,
    sentAt: new Date(Number(e.ts) * 1000),
    body,
    raw: e,
  };
}

/**
 * Socket Mode Slack uygulaması: dışarıya açık bir URL gerektirmez.
 * Gerekli olaylar: message.channels/groups/im/mpim ve member_joined_channel; bildirim için chat:write.
 */
export const slackConnector: ConnectorFactory = (ctx) => {
  const { botToken, appToken } = ctx.secrets;
  if (!botToken || !appToken) throw new Error('Slack hesabında botToken ve appToken gerekli');
  const app = new bolt.App({ token: botToken, appToken, socketMode: true });
  const userNames = new Map<string, string | null>();
  const channelNames = new Map<string, string | null>();
  let botUserId: string | null = null;

  const userName = async (id?: string) => {
    if (!id) return null;
    if (!userNames.has(id)) {
      const r = await app.client.users.info({ user: id }).catch(() => null);
      userNames.set(id, r?.user?.profile?.real_name || r?.user?.name || null);
    }
    return userNames.get(id) ?? null;
  };
  const channelName = async (id: string) => {
    if (!channelNames.has(id)) {
      const r = await app.client.conversations.info({ channel: id }).catch(() => null);
      channelNames.set(id, r?.channel?.name ? `#${r.channel.name}` : null);
    }
    return channelNames.get(id) ?? null;
  };

  app.message(async ({ message }) => {
    const e = message as unknown as SlackMessageEvent;
    const gone = slackDeletion(e);
    if (gone) {
      await deleteIncomingMessage(ctx.db, ctx.account.id, gone.channel, gone.ts);
      return;
    }
    const author = e.subtype === 'message_changed' ? e.message?.user : e.user;
    const incoming = slackToIncoming(e, { channel: await channelName(e.channel), user: await userName(author) });
    if (incoming) await ctx.ingest(incoming);
  });

  // Bot bir kanala eklendiğinde kanala bilgilendirme yazılır.
  app.event('member_joined_channel', async ({ event }) => {
    const text = groupNotice(ctx.account.config);
    if (!text || !botUserId || event.user !== botUserId) return;
    await app.client.chat.postMessage({ channel: event.channel, text })
      .catch((err) => ctx.log.warn({ err }, 'kanala bilgilendirme mesajı gönderilemedi'));
  });
  app.error(async (err) => ctx.log.error({ err }, 'slack olayı işlenemedi'));

  return {
    async start() {
      await app.start();
      botUserId = (await app.client.auth.test().catch(() => null))?.user_id ?? null;
      await ctx.setStatus('connected');
    },
    async stop() {
      await app.stop();
    },
  };
};
