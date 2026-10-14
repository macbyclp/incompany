import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { IncomingMessage } from '../core/ingest.js';
import type { ConnectorFactory } from './types.js';

const addr = (a: ParsedMail['from']) => a?.value?.[0];

/** To ve Cc adresleri; kendi gönderdiğim bir e-postada "beni kaydetme" kontrolü için kullanılır. */
const recipients = (mail: ParsedMail): string[] => {
  const lists = [mail.to, mail.cc].flatMap((x) => (x ? (Array.isArray(x) ? x : [x]) : []));
  return lists.flatMap((l) => l.value.map((v) => v.address).filter((a): a is string => Boolean(a)));
};

export function emailToIncoming(mail: ParsedMail, fallbackId: string, ownAddress?: string): IncomingMessage | null {
  const body = (mail.text ?? (mail.html ? String(mail.html).replace(/<[^>]+>/g, ' ') : '')).replace(/\s+\n/g, '\n').trim();
  const subject = mail.subject?.trim() || null;
  if (!body && !subject) return null;
  const messageId = mail.messageId ?? fallbackId;
  const refs = Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [];
  // Bir yazışmanın tüm e-postaları ilk mesajın kimliği altında tek konuşmada toplanır.
  const threadId = refs[0] ?? mail.inReplyTo ?? messageId;
  const from = addr(mail.from);
  const fromMe = Boolean(ownAddress && from?.address?.toLowerCase() === ownAddress.toLowerCase());
  return {
    conversation: { externalId: threadId, kind: 'email', title: subject?.replace(/^((re|fwd?|ynt|ilt)\s*:\s*)+/i, '') ?? null },
    externalId: messageId,
    senderExternalId: from?.address ?? null,
    senderName: from?.name || from?.address || null,
    fromMe,
    counterparts: recipients(mail),
    sentAt: mail.date ?? new Date(),
    subject,
    body,
    raw: { messageId, inReplyTo: mail.inReplyTo, references: refs,
      to: mail.to && (Array.isArray(mail.to) ? mail.to : [mail.to]).flatMap((t) => t.value.map((v) => v.address)) },
  };
}

interface Cursor { uidValidity: string; lastUid: number }

/**
 * IMAP kutusunu izler. config: { host, port?, secure?, user, mailboxes?, sinceDays? };
 * secrets: { password } (Gmail'de uygulama şifresi). Okunan konum config.cursors'ta saklanır.
 */
export const emailConnector: ConnectorFactory = (ctx) => {
  const cfg = ctx.account.config;
  if (!cfg.host || !cfg.user || !ctx.secrets.password) throw new Error('E-posta hesabında host, user ve password gerekli');
  const mailboxes: string[] = cfg.mailboxes ?? ['INBOX'];
  const sinceDays: number = cfg.sinceDays ?? 90;
  const intervalMs: number = (cfg.pollSeconds ?? 120) * 1000;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;

  const saveCursor = async (mailbox: string, cursor: Cursor) => {
    await ctx.db.query(
      `UPDATE accounts SET config = config || jsonb_build_object('cursors',
         coalesce(config->'cursors', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb))
        WHERE id = $1`,
      [ctx.account.id, mailbox, JSON.stringify(cursor)]);
    (cfg.cursors ??= {})[mailbox] = cursor;
  };

  const syncOnce = async () => {
    if (running) return;
    running = true;
    const client = new ImapFlow({
      host: cfg.host, port: cfg.port ?? 993, secure: cfg.secure ?? true,
      auth: { user: cfg.user, pass: ctx.secrets.password! }, logger: false,
    });
    try {
      await client.connect();
      for (const mailbox of mailboxes) {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const box = client.mailbox;
          if (!box) continue;
          const validity = String(box.uidValidity);
          const prev: Cursor | undefined = cfg.cursors?.[mailbox];
          const range = prev && prev.uidValidity === validity
            ? { uid: `${prev.lastUid + 1}:*` }
            : { since: new Date(Date.now() - sinceDays * 86_400_000) };
          let lastUid = prev?.uidValidity === validity ? prev.lastUid : 0;
          const uids = await client.search(range, { uid: true }) || [];
          for (const uid of uids.filter((u) => u > lastUid).sort((a, b) => a - b)) {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (msg && msg.source) {
              const incoming = emailToIncoming(await simpleParser(msg.source), `${mailbox}:${validity}:${uid}`, cfg.user);
              if (incoming) await ctx.ingest(incoming);
            }
            lastUid = uid;
            await saveCursor(mailbox, { uidValidity: validity, lastUid });
          }
        } finally {
          lock.release();
        }
      }
      await ctx.setStatus('connected', new Date().toISOString());
    } catch (err: any) {
      ctx.log.error({ err }, 'e-posta eşitlemesi başarısız');
      await ctx.setStatus('error', String(err?.message ?? err));
    } finally {
      await client.logout().catch(() => {});
      running = false;
    }
  };

  const loop = async () => {
    await syncOnce();
    if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
  };

  return {
    async start() {
      stopped = false;
      void loop();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
};
