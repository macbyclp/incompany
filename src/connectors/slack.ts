import bolt from '@slack/bolt';
import type { IncomingMessage } from '../core/ingest.js';
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
}

export function slackToIncoming(
  e: SlackMessageEvent, names: { channel?: string | null; user?: string | null },
): IncomingMessage | null {
  // Düzenleme/silme/katılım gibi alt tipler hafızaya yazılmaz; dosya paylaşımı metniyle kalır.
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

/** Socket Mode Slack uygulaması: dışarıya açık bir URL gerektirmez. */
export const slackConnector: ConnectorFactory = (ctx) => {
  const { botToken, appToken } = ctx.secrets;
  if (!botToken || !appToken) throw new Error('Slack hesabında botToken ve appToken gerekli');
  const app = new bolt.App({ token: botToken, appToken, socketMode: true });
  const userNames = new Map<string, string | null>();
  const channelNames = new Map<string, string | null>();

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
    const incoming = slackToIncoming(e, { channel: await channelName(e.channel), user: await userName(e.user) });
    if (incoming) await ctx.ingest(incoming);
  });
  app.error(async (err) => ctx.log.error({ err }, 'slack olayı işlenemedi'));

  return {
    async start() {
      await app.start();
      await ctx.setStatus('connected');
    },
    async stop() {
      await app.stop();
    },
  };
};
