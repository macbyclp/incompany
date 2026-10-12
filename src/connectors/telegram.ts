import { Bot } from 'grammy';
import type { Message } from 'grammy/types';
import type { IncomingMessage } from '../core/ingest.js';
import type { ConnectorFactory } from './types.js';

export function telegramToIncoming(m: Message): IncomingMessage | null {
  const body = m.text ?? m.caption ?? '';
  if (!body.trim()) return null;
  const chat = m.chat;
  const kind = chat.type === 'private' ? 'dm' : chat.type === 'channel' ? 'channel' : 'group';
  const title = 'title' in chat && chat.title
    ? chat.title
    : [('first_name' in chat && chat.first_name) || '', ('last_name' in chat && chat.last_name) || '']
        .join(' ').trim() || null;
  const from = m.from;
  const senderName = from
    ? [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || null
    : m.author_signature ?? title;
  return {
    conversation: { externalId: String(chat.id), kind, title },
    externalId: String(m.message_id),
    senderExternalId: from ? String(from.id) : null,
    senderName,
    sentAt: new Date(m.date * 1000),
    body,
    raw: m,
  };
}

/**
 * Şirket botu. Grup mesajlarını görebilmesi için BotFather'da /setprivacy → Disable
 * yapılmalı ya da bot grupta yönetici olmalı.
 */
export const telegramConnector: ConnectorFactory = (ctx) => {
  const token = ctx.secrets.botToken;
  if (!token) throw new Error('Telegram hesabında botToken yok');
  const bot = new Bot(token);
  const handle = async (m: Message | undefined) => {
    const incoming = m && telegramToIncoming(m);
    if (incoming) await ctx.ingest(incoming);
  };
  bot.on('message', (c) => handle(c.message));
  bot.on('edited_message', (c) => handle(c.editedMessage));
  bot.on('channel_post', (c) => handle(c.channelPost));
  bot.catch((err) => ctx.log.error({ err: err.error }, 'telegram güncellemesi işlenemedi'));

  return {
    async start() {
      await bot.init();
      void bot.start({
        allowed_updates: ['message', 'edited_message', 'channel_post'],
        onStart: () => void ctx.setStatus('connected', `@${bot.botInfo.username}`),
      }).catch((err) => {
        ctx.log.error({ err }, 'telegram durdu');
        void ctx.setStatus('error', String(err?.message ?? err));
      });
    },
    async stop() {
      await bot.stop();
    },
  };
};
