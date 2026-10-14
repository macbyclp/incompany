import { Bot } from 'grammy';
import type { ChatMemberUpdated, Message } from 'grammy/types';
import type { IncomingMessage } from '../core/ingest.js';
import { groupNotice } from './notice.js';
import type { ConnectorFactory } from './types.js';

export function telegramToIncoming(m: Message, opts: { edited?: boolean } = {}): IncomingMessage | null {
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
    edit: opts.edited || undefined,
  };
}

/** Bot bir gruba (yeniden) eklendi mi? Yalnız grup ve süper gruplarda duyuru yapılır. */
export function botJoinedGroup(u: Pick<ChatMemberUpdated, 'chat' | 'old_chat_member' | 'new_chat_member'>): boolean {
  if (u.chat.type !== 'group' && u.chat.type !== 'supergroup') return false;
  const was = u.old_chat_member.status, now = u.new_chat_member.status;
  const present = (s: string) => s === 'member' || s === 'administrator' || s === 'creator';
  return !present(was) && present(now);
}

/**
 * Şirket botu. Grup mesajlarını görebilmesi için BotFather'da /setprivacy → Disable
 * yapılmalı ya da bot grupta yönetici olmalı.
 *
 * Sınır: Telegram Bot API botlara silinen mesajı bildirmez; kaynakta silinen Telegram mesajı
 * burada kalır (silinmesi gerekiyorsa veri talebi / "beni kaydetme" yolu kullanılır).
 */
export const telegramConnector: ConnectorFactory = (ctx) => {
  const token = ctx.secrets.botToken;
  if (!token) throw new Error('Telegram hesabında botToken yok');
  const bot = new Bot(token);
  const handle = async (m: Message | undefined, edited = false) => {
    const incoming = m && telegramToIncoming(m, { edited });
    if (incoming) await ctx.ingest(incoming);
  };
  bot.on('message', (c) => handle(c.message));
  bot.on('edited_message', (c) => handle(c.editedMessage, true));
  bot.on('channel_post', (c) => handle(c.channelPost));
  bot.on('edited_channel_post', (c) => handle(c.editedChannelPost, true));
  bot.on('my_chat_member', async (c) => {
    const text = groupNotice(ctx.account.config);
    if (!text || !botJoinedGroup(c.myChatMember)) return;
    await bot.api.sendMessage(c.myChatMember.chat.id, text)
      .catch((err) => ctx.log.warn({ err }, 'gruba bilgilendirme mesajı gönderilemedi'));
  });
  bot.catch((err) => ctx.log.error({ err: err.error }, 'telegram güncellemesi işlenemedi'));

  return {
    async start() {
      await bot.init();
      void bot.start({
        allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member'],
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
