import Fastify, { type FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { createAccount, getAccount, listAccounts, needsConsent, type AccountKind } from '../core/accounts.js';
import { grantConsent, revokeConsent, setCapture } from '../core/consent.js';
import { moveConversation } from '../core/ingest.js';
import { search } from '../core/search.js';
import { createUser, ensureCompanySpace, personalSpaceId, spaceRole, userByToken, type User } from '../core/users.js';
import type { Db } from '../db/client.js';
import { indexHtml } from './page.js';

export interface ConnectorControl {
  start(accountId: number): Promise<void>;
  stop(accountId: number): Promise<void>;
  pairingQr(accountId: number): string | null;
  sessionDir(kind: AccountKind, accountId: number): string;
}

declare module 'fastify' {
  interface FastifyRequest { user: User }
}

class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const id = z.coerce.number().int().positive();

const newAccount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('whatsapp'), label: z.string().min(1) }),
  z.object({
    kind: z.literal('email'), label: z.string().min(1),
    config: z.object({
      host: z.string().min(1), port: z.number().int().optional(), secure: z.boolean().optional(),
      user: z.string().min(1), mailboxes: z.array(z.string()).optional(),
      sinceDays: z.number().int().positive().optional(), pollSeconds: z.number().int().min(30).optional(),
    }),
    secrets: z.object({ password: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal('telegram'), label: z.string().min(1), space: z.enum(['personal', 'company']).default('company'),
    secrets: z.object({ botToken: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal('slack'), label: z.string().min(1), space: z.enum(['personal', 'company']).default('company'),
    secrets: z.object({ botToken: z.string().min(1), appToken: z.string().min(1) }),
  }),
]);

const scopeSchema = z.object({
  dm: z.enum(['all', 'selected', 'none']),
  group: z.enum(['all', 'selected', 'none']),
  history: z.boolean(),
});

export function buildServer(opts: { db: Db; appSecret: string; connectors: ConnectorControl; logger?: boolean }) {
  const { db, appSecret, connectors } = opts;
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Geçersiz istek', issues: err.issues });
    const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (code === 500) app.log.error(err);
    return reply.code(code).send({ error: code === 500 ? 'Sunucu hatası' : err.message });
  });

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(indexHtml));
  app.get('/health', async () => ({ ok: true }));

  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (req.url === '/' || req.url === '/health') return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = token ? await userByToken(db, token) : null;
    if (!user) throw new HttpError(401, 'Geçerli bir token gerekli');
    req.user = user;
  });

  const ownAccount = async (req: FastifyRequest, accountId: number) => {
    const acc = await getAccount(db, accountId);
    if (!acc || acc.owner_user_id !== req.user.id) throw new HttpError(404, 'Hesap bulunamadı');
    return acc;
  };

  app.get('/me', async (req) => req.user);

  app.get('/spaces', async (req) => (await db.query(
    `SELECT s.id, s.kind, s.name, sm.role FROM spaces s
       JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = $1 ORDER BY s.kind, s.id`,
    [req.user.id])).rows.map((r) => ({ ...r, id: Number(r.id) })));

  app.get('/search', async (req) => {
    const q = z.object({
      q: z.string().min(1), space: id.optional(), limit: z.coerce.number().int().optional(),
      source: z.enum(['whatsapp', 'telegram', 'slack', 'email']).optional(),
    }).parse(req.query);
    return search(db, req.user.id, q.q, { spaceId: q.space, source: q.source, limit: q.limit });
  });

  // Sahibinin kendi konuşmaları (toplanmayanlar dahil) ile üyesi olduğu alanlardaki konuşmalar.
  app.get('/conversations', async (req) => {
    const q = z.object({ space: id.optional() }).parse(req.query);
    const { rows } = await db.query(
      `SELECT c.id, c.kind, c.title, c.space_id, c.capture, a.kind AS source, a.id AS account_id,
              a.owner_user_id = $1 AS mine
         FROM conversations c JOIN accounts a ON a.id = c.account_id
        WHERE ($2::bigint IS NULL OR c.space_id = $2)
          AND (a.owner_user_id = $1
               OR (c.capture AND c.space_id IN (SELECT space_id FROM space_members WHERE user_id = $1)))
        ORDER BY c.id DESC LIMIT 500`,
      [req.user.id, q.space ?? null]);
    return rows.map((r) => ({ ...r, id: Number(r.id), space_id: Number(r.space_id), account_id: Number(r.account_id) }));
  });

  // "selected" kipinde sahibi hangi konuşmanın toplanacağını burada seçer.
  app.post('/conversations/:id/capture', async (req) => {
    const { id: cid } = z.object({ id }).parse(req.params);
    const body = z.object({ capture: z.boolean(), purge: z.boolean().default(false) }).parse(req.body);
    try { await setCapture(db, cid, req.user.id, body.capture, body.purge); }
    catch { throw new HttpError(404, 'Konuşma bulunamadı'); }
    return { ok: true };
  });

  // Bir konuşmayı kişisel alandan ortak alana açmak yalnız hesabın sahibinin kararıdır.
  app.post('/conversations/:id/move', async (req) => {
    const { id: cid } = z.object({ id }).parse(req.params);
    const { space } = z.object({ space: id }).parse(req.body);
    const { rows } = await db.query(
      `SELECT 1 FROM conversations c JOIN accounts a ON a.id = c.account_id
        WHERE c.id = $1 AND a.owner_user_id = $2`, [cid, req.user.id]);
    if (!rows[0]) throw new HttpError(404, 'Konuşma bulunamadı');
    if (!(await spaceRole(db, req.user.id, space))) throw new HttpError(403, 'Bu alanın üyesi değilsiniz');
    await moveConversation(db, cid, space);
    return { ok: true };
  });

  app.get('/accounts', async (req) => (await listAccounts(db, { ownerUserId: req.user.id }))
    .map(({ id: aid, kind, label, status, status_detail, enabled, consent_at, consent_scope }) =>
      ({ id: aid, kind, label, status, status_detail, enabled, consent_at, consent_scope })));

  app.post('/accounts', async (req, reply) => {
    const body = newAccount.parse(req.body);
    if ((body.kind === 'telegram' || body.kind === 'slack') && body.space === 'company' && !req.user.is_admin) {
      // Şirket botlarını yalnız yönetici kurar; grup üyeleri botu görebilir, kişisel hesap değildir.
      throw new HttpError(403, 'Şirket botunu yalnız yönetici ekler');
    }
    const defaultSpace = 'space' in body && body.space === 'company'
      ? await ensureCompanySpace(db)
      : await personalSpaceId(db, req.user.id);
    const acc = await createAccount(db, appSecret, {
      kind: body.kind, ownerUserId: req.user.id, label: body.label, defaultSpaceId: defaultSpace,
      config: 'config' in body ? body.config : {}, secrets: 'secrets' in body ? body.secrets : undefined,
    });
    // Kişisel kaynaklar rıza verilene kadar başlatılmaz.
    if (needsConsent(acc.kind)) {
      await db.query(`UPDATE accounts SET status = 'awaiting_consent' WHERE id = $1`, [acc.id]);
    } else {
      await connectors.start(acc.id);
    }
    return reply.code(201).send({
      id: acc.id, kind: acc.kind, label: acc.label,
      next: needsConsent(acc.kind) ? `POST /accounts/${acc.id}/consent` : null,
    });
  });

  app.post('/accounts/:id/consent', async (req) => {
    const { id: aid } = z.object({ id }).parse(req.params);
    await ownAccount(req, aid);
    const scope = scopeSchema.parse(req.body);
    try { await grantConsent(db, aid, req.user.id, scope); }
    catch (err: any) { throw new HttpError(400, err.message); }
    await connectors.start(aid);
    return { ok: true };
  });

  // Rızayı geri çek: purge alanı bilinçli seçim için zorunludur.
  app.delete('/accounts/:id/consent', async (req) => {
    const { id: aid } = z.object({ id }).parse(req.params);
    const acc = await ownAccount(req, aid);
    const { purge } = z.object({ purge: z.boolean() }).parse(req.body);
    await connectors.stop(aid);
    await revokeConsent(db, aid, req.user.id, { purge, sessionDir: connectors.sessionDir(acc.kind, aid) });
    return { ok: true, purged: purge };
  });

  app.get('/accounts/:id/qr', async (req) => {
    const { id: aid } = z.object({ id }).parse(req.params);
    const acc = await ownAccount(req, aid);
    if (acc.kind !== 'whatsapp') throw new HttpError(400, 'Yalnız WhatsApp hesapları QR ile eşleşir');
    const qr = connectors.pairingQr(aid);
    return { status: acc.status, qr: qr ? await QRCode.toDataURL(qr, { margin: 1, width: 320 }) : null };
  });

  app.get('/consent-log', async (req) => (await db.query(
    `SELECT account_id, action, scope, purged, at FROM consent_log
      WHERE user_id = $1 ORDER BY id DESC LIMIT 200`, [req.user.id])).rows);

  // Panelin ana sayfası: yalnız kullanıcının erişebildiği alanlardaki sayılar.
  app.get('/overview', async (req) => {
    const uid = req.user.id;
    const totals = (await db.query(
      `SELECT count(*) AS messages, count(DISTINCT m.conversation_id) AS conversations
         FROM messages m JOIN space_members sm ON sm.space_id = m.space_id AND sm.user_id = $1`, [uid])).rows[0]!;
    const bySource = (await db.query(
      `SELECT a.kind AS source, count(*) AS n FROM messages m
         JOIN space_members sm ON sm.space_id = m.space_id AND sm.user_id = $1
         JOIN conversations c ON c.id = m.conversation_id JOIN accounts a ON a.id = c.account_id
        GROUP BY a.kind ORDER BY n DESC`, [uid])).rows;
    const bySpace = (await db.query(
      `SELECT s.id, s.kind, s.name, count(m.id) AS n FROM spaces s
         JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = $1
         LEFT JOIN messages m ON m.space_id = s.id GROUP BY s.id ORDER BY s.kind, s.id`, [uid])).rows;
    const daily = (await db.query(
      `SELECT to_char(date_trunc('day', m.sent_at), 'YYYY-MM-DD') AS day, count(*) AS n FROM messages m
         JOIN space_members sm ON sm.space_id = m.space_id AND sm.user_id = $1
        WHERE m.sent_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`, [uid])).rows;
    const accounts = (await listAccounts(db, { ownerUserId: uid }));
    return {
      messages: Number(totals.messages), conversations: Number(totals.conversations),
      accounts: accounts.length, connected: accounts.filter((a) => a.status === 'connected').length,
      bySource: bySource.map((r) => ({ source: r.source, n: Number(r.n) })),
      bySpace: bySpace.map((r) => ({ id: Number(r.id), kind: r.kind, name: r.name, n: Number(r.n) })),
      daily: daily.map((r) => ({ day: r.day, n: Number(r.n) })),
    };
  });

  app.get('/conversations/:id/messages', async (req) => {
    const { id: cid } = z.object({ id }).parse(req.params);
    const { rows } = await db.query(
      `SELECT m.id, m.sender_name, m.from_me, m.sent_at, m.subject, m.body
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         JOIN accounts a ON a.id = c.account_id
        WHERE c.id = $1 AND (a.owner_user_id = $2
              OR m.space_id IN (SELECT space_id FROM space_members WHERE user_id = $2))
        ORDER BY m.sent_at DESC LIMIT 100`, [cid, req.user.id]);
    return rows.map((r) => ({ ...r, id: Number(r.id) })).reverse();
  });

  // Bir kaynağı tamamen kaldırır: durdurur, oturum dosyalarını ve topladığı her şeyi siler.
  app.delete('/accounts/:id', async (req) => {
    const { id: aid } = z.object({ id }).parse(req.params);
    const acc = await ownAccount(req, aid);
    await connectors.stop(aid);
    await revokeConsent(db, aid, req.user.id, { purge: true, sessionDir: connectors.sessionDir(acc.kind, aid) })
      .catch(() => {});
    await db.query('DELETE FROM accounts WHERE id = $1', [aid]);
    return { ok: true };
  });

  app.get('/users', async (req) => {
    if (!req.user.is_admin) throw new HttpError(403, 'Yalnız yönetici kullanıcıları görür');
    return (await db.query(
      `SELECT u.id, u.name, u.email, u.is_admin, u.created_at, count(a.id) AS accounts
         FROM users u LEFT JOIN accounts a ON a.owner_user_id = u.id GROUP BY u.id ORDER BY u.id`))
      .rows.map((r) => ({ ...r, id: Number(r.id), accounts: Number(r.accounts) }));
  });

  app.post('/users', async (req, reply) => {
    if (!req.user.is_admin) throw new HttpError(403, 'Yalnız yönetici kullanıcı ekler');
    const body = z.object({ name: z.string().min(1), email: z.string().email().optional(), isAdmin: z.boolean().default(false) })
      .parse(req.body);
    const { user, token } = await createUser(db, body);
    return reply.code(201).send({ user, token });
  });

  return app;
}
