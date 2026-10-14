import Fastify, { type FastifyRequest } from 'fastify';
import { rm } from 'node:fs/promises';
import QRCode from 'qrcode';
import { z } from 'zod';
import { createAccount, getAccount, listAccounts, needsConsent, type AccountKind, type SecretKey } from '../core/accounts.js';
import { audit, listAudit } from '../core/audit.js';
import { grantConsent, revokeConsent, setCapture } from '../core/consent.js';
import { connectorHealth, problemAccounts } from '../core/health.js';
import { moveConversation } from '../core/ingest.js';
import { accountsOf, offboardUser } from '../core/offboarding.js';
import { addExclusion, erasePersonData, exportPersonData, listExclusions, personExportCsv, removeExclusion } from '../core/privacy.js';
import { search } from '../core/search.js';
import { getCompanyRetention, getConsentText, setCompanyRetention, setConsentText } from '../core/settings.js';
import { addSpaceMember, createTeamSpace, listSpaceMembers, removeSpaceMember } from '../core/spaces.js';
import { createUser, ensureCompanySpace, listUsers, personalSpaceId, resetToken, revokeToken, spaceRole, userByToken, type User } from '../core/users.js';
import type { Db } from '../db/client.js';
import { indexHtml } from './page.js';
import { FailureLock, RateLimiter } from './ratelimit.js';

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
  constructor(public statusCode: number, message: string, public headers?: Record<string, string>) { super(message); }
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
    config: z.object({ notice: z.union([z.string().max(500), z.literal(false)]).optional() }).optional(),
    secrets: z.object({ botToken: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal('slack'), label: z.string().min(1), space: z.enum(['personal', 'company']).default('company'),
    config: z.object({ notice: z.union([z.string().max(500), z.literal(false)]).optional() }).optional(),
    secrets: z.object({ botToken: z.string().min(1), appToken: z.string().min(1) }),
  }),
]);

const scopeSchema = z.object({
  dm: z.enum(['all', 'selected', 'none']),
  group: z.enum(['all', 'selected', 'none']),
  history: z.boolean(),
  retention_days: z.number().int().min(1).max(3650).nullable().optional(),
  /** Kişinin onayladığı aydınlatma metninin sürümü. */
  textVersion: z.number().int().optional(),
});

export interface ServerOptions {
  db: Db;
  appSecret: SecretKey;
  connectors: ConnectorControl;
  logger?: boolean;
  /** Ters vekil (Caddy/nginx) arkasında istemci IP'sini X-Forwarded-For'dan okur. */
  trustProxy?: boolean;
  limits?: { searchPerMinute?: number; failuresBeforeLock?: number; lockMinutes?: number; sensitivePerMinute?: number };
}

export function buildServer(opts: ServerOptions) {
  const { db, appSecret, connectors } = opts;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false });

  const searchLimit = new RateLimiter(opts.limits?.searchPerMinute ?? 60, 60_000);
  const sensitiveLimit = new RateLimiter(opts.limits?.sensitivePerMinute ?? 20, 60_000);
  const authLock = new FailureLock(opts.limits?.failuresBeforeLock ?? 10, 15 * 60_000, (opts.limits?.lockMinutes ?? 15) * 60_000);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Geçersiz istek', issues: err.issues });
    const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (code === 500) app.log.error(err);
    if (err.headers) reply.headers(err.headers);
    return reply.code(code).send({ error: code === 500 ? 'Sunucu hatası' : err.message });
  });

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(indexHtml));

  // Herkese açık, yalnız sayılar: Docker healthcheck ve dış izleme için. Etiket/kimlik içermez.
  app.get('/health', async (_req, reply) => {
    try {
      const connectorsHealth = await connectorHealth(db);
      return { ok: true, db: true, connectors: connectorsHealth };
    } catch {
      return reply.code(503).send({ ok: false, db: false });
    }
  });

  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (req.url === '/' || req.url === '/health') return;
    const locked = authLock.remaining(req.ip);
    if (locked) throw new HttpError(429, 'Çok fazla başarısız deneme; bir süre sonra tekrar deneyin', { 'retry-after': String(locked) });
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = token ? await userByToken(db, token) : null;
    if (!user) {
      // Yalnız sunulup reddedilen anahtar deneme sayılır; anahtarsız istekler (favicon, tarayıcı yoklamaları,
      // oturumu kapalı panel) bir ağdaki herkesi kilitlemesin.
      if (token) authLock.fail(req.ip);
      throw new HttpError(401, 'Geçerli bir token gerekli');
    }
    req.user = user;
  });

  const requireAdmin = (req: FastifyRequest, msg = 'Bu işlem yalnız yöneticiye açık') => {
    if (!req.user.is_admin) throw new HttpError(403, msg);
  };

  const limited = (limiter: RateLimiter, req: FastifyRequest) => {
    const wait = limiter.consume(`${req.user.id}`);
    if (wait !== null) throw new HttpError(429, 'Çok sık istek; biraz bekleyin', { 'retry-after': String(wait) });
  };

  /** Çekirdek işlevlerin Türkçe hata iletilerini 4xx olarak döndürür; veritabanı hataları 500 kalır. */
  const run = async <T>(fn: () => Promise<T>, status = 400): Promise<T> => {
    try { return await fn(); } catch (err: any) {
      if (err instanceof HttpError || err instanceof z.ZodError || err?.code) throw err;
      throw new HttpError(status, err?.message ?? 'İşlem yapılamadı');
    }
  };

  const ownAccount = async (req: FastifyRequest, accountId: number) => {
    const acc = await getAccount(db, accountId);
    if (!acc || acc.owner_user_id !== req.user.id) throw new HttpError(404, 'Hesap bulunamadı');
    return acc;
  };

  /** Hesap sahibi ya da (şirket botları için) yönetici. Kişisel hesaplara yönetici de dokunamaz. */
  const manageableAccount = async (req: FastifyRequest, accountId: number) => {
    const acc = await getAccount(db, accountId);
    if (!acc) throw new HttpError(404, 'Hesap bulunamadı');
    if (acc.owner_user_id === req.user.id) return acc;
    if (req.user.is_admin && !needsConsent(acc.kind)) return acc;
    throw new HttpError(404, 'Hesap bulunamadı');
  };

  app.get('/me', async (req) => req.user);

  app.post('/me/token/rotate', async (req) => ({ token: await run(() => resetToken(db, req.user.id, req.user.id)) }));

  // ---------- alanlar ve ekip ----------
  app.get('/spaces', async (req) => (await db.query(
    `SELECT s.id, s.kind, s.name, sm.role FROM spaces s
       JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = $1 ORDER BY s.kind, s.id`,
    [req.user.id])).rows.map((r) => ({ ...r, id: Number(r.id) })));

  // Yönetici tüm ekip alanlarını (üyesi olmasa da) üye sayısıyla görür; içeriklerine erişimi bundan doğmaz.
  app.get('/spaces/team', async (req) => {
    requireAdmin(req);
    return (await db.query(
      `SELECT s.id, s.name, count(sm.user_id) AS members FROM spaces s
         LEFT JOIN space_members sm ON sm.space_id = s.id WHERE s.kind = 'team' GROUP BY s.id ORDER BY s.name`))
      .rows.map((r) => ({ id: Number(r.id), name: r.name, members: Number(r.members) }));
  });

  app.post('/spaces', async (req, reply) => {
    requireAdmin(req, 'Ekip alanını yalnız yönetici kurar');
    const { name } = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    return reply.code(201).send(await run(() => createTeamSpace(db, req.user.id, name)));
  });

  /** Alanın yöneticisi ya da genel yönetici üyeleri yönetir. */
  const manageSpace = async (req: FastifyRequest, spaceId: number) => {
    const role = await spaceRole(db, req.user.id, spaceId);
    if (!req.user.is_admin && role !== 'admin') throw new HttpError(403, 'Bu alanı yönetme yetkiniz yok');
  };

  app.get('/spaces/:id/members', async (req) => {
    const { id: sid } = z.object({ id }).parse(req.params);
    if (!(await spaceRole(db, req.user.id, sid)) && !req.user.is_admin) throw new HttpError(404, 'Alan bulunamadı');
    return listSpaceMembers(db, sid);
  });

  app.post('/spaces/:id/members', async (req) => {
    const { id: sid } = z.object({ id }).parse(req.params);
    await manageSpace(req, sid);
    const body = z.object({ userId: id, role: z.enum(['member', 'admin']).default('member') }).parse(req.body);
    await run(() => addSpaceMember(db, req.user.id, sid, body.userId, body.role));
    return { ok: true };
  });

  app.delete('/spaces/:id/members/:userId', async (req) => {
    const p = z.object({ id, userId: id }).parse(req.params);
    await manageSpace(req, p.id);
    await run(() => removeSpaceMember(db, req.user.id, p.id, p.userId), 404);
    return { ok: true };
  });

  // ---------- arama ve konuşmalar ----------
  app.get('/search', async (req) => {
    limited(searchLimit, req);
    const q = z.object({
      q: z.string().min(1).max(200), space: id.optional(), limit: z.coerce.number().int().optional(),
      offset: z.coerce.number().int().min(0).max(10_000).optional(),
      source: z.enum(['whatsapp', 'telegram', 'slack', 'email']).optional(),
    }).parse(req.query);
    return db.asUser(req.user.id, (tx) => search(tx, req.user.id, q.q, {
      spaceId: q.space, source: q.source, limit: q.limit, offset: q.offset }));
  });

  // Sahibinin kendi konuşmaları (toplanmayanlar dahil) ile üyesi olduğu alanlardaki konuşmalar.
  app.get('/conversations', async (req) => {
    const q = z.object({
      space: id.optional(), source: z.enum(['whatsapp', 'telegram', 'slack', 'email']).optional(),
      q: z.string().max(100).optional(), before: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
    const rows = await db.asUser(req.user.id, async (tx) => (await tx.query(
      `SELECT c.id, c.kind, c.title, c.space_id, c.capture, a.kind AS source, a.id AS account_id,
              a.owner_user_id = $1 AS mine,
              (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS messages,
              (SELECT max(m.sent_at) FROM messages m WHERE m.conversation_id = c.id) AS last_at
         FROM conversations c JOIN accounts a ON a.id = c.account_id
        WHERE ($2::bigint IS NULL OR c.space_id = $2)
          AND ($3::text IS NULL OR a.kind = $3)
          AND ($4::text IS NULL OR c.title ILIKE $4)
          AND ($5::bigint IS NULL OR c.id < $5)
          AND (a.owner_user_id = $1
               OR (c.capture AND c.space_id IN (SELECT space_id FROM space_members WHERE user_id = $1)))
        ORDER BY c.id DESC LIMIT $6`,
      [req.user.id, q.space ?? null, q.source ?? null, like, q.before ?? null, q.limit + 1])).rows);
    const page = rows.slice(0, q.limit).map((r) => ({ ...r, id: Number(r.id), space_id: Number(r.space_id),
      account_id: Number(r.account_id), messages: Number(r.messages) }));
    return { items: page, next: rows.length > q.limit ? page[page.length - 1]!.id : null };
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

  const visibleConversation = async (tx: Db, cid: number) => {
    const { rows } = await tx.query('SELECT id FROM conversations WHERE id = $1', [cid]);
    if (!rows[0]) throw new HttpError(404, 'Konuşma bulunamadı');
  };

  app.get('/conversations/:id/messages', async (req) => {
    const { id: cid } = z.object({ id }).parse(req.params);
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(100),
      beforeAt: z.string().datetime().optional(), beforeId: id.optional(),
    }).parse(req.query);
    return db.asUser(req.user.id, async (tx) => {
      await visibleConversation(tx, cid);
      const { rows } = await tx.query(
        `SELECT m.id, m.sender_name, m.from_me, m.sent_at, m.subject, m.body, m.edited_at
           FROM messages m
          WHERE m.conversation_id = $1
            AND ($2::timestamptz IS NULL OR (m.sent_at, m.id) < ($2::timestamptz, $3::bigint))
          ORDER BY m.sent_at DESC, m.id DESC LIMIT $4`,
        [cid, q.beforeAt ?? null, q.beforeId ?? 0, q.limit + 1]);
      const page = rows.slice(0, q.limit).map((r) => ({ ...r, id: Number(r.id) }));
      return { items: page.reverse(), hasMore: rows.length > q.limit };
    });
  });

  // Konuşmada kim ne kadar yazmış, son aktivite.
  app.get('/conversations/:id/people', async (req) => {
    const { id: cid } = z.object({ id }).parse(req.params);
    return db.asUser(req.user.id, async (tx) => {
      await visibleConversation(tx, cid);
      const { rows } = await tx.query(
        `SELECT coalesce(sender_name, sender_external_id) AS name, bool_or(from_me) AS me,
                count(*) AS messages, max(sent_at) AS last_at
           FROM messages WHERE conversation_id = $1
          GROUP BY coalesce(sender_name, sender_external_id) ORDER BY messages DESC, last_at DESC LIMIT 100`, [cid]);
      return rows.map((r) => ({ ...r, messages: Number(r.messages) }));
    });
  });

  // ---------- kaynaklar ----------
  app.get('/accounts', async (req) => (await listAccounts(db, { ownerUserId: req.user.id }))
    .map(({ id: aid, kind, label, status, status_detail, enabled, consent_at, consent_scope, consent_text_version, last_sync_at, status_at }) =>
      ({ id: aid, kind, label, status, status_detail, enabled, consent_at, consent_scope, consent_text_version, last_sync_at, status_at })));

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
      config: 'config' in body ? body.config ?? {} : {}, secrets: 'secrets' in body ? body.secrets : undefined,
    });
    await audit(db, req.user.id, 'account.create', { type: 'account', id: acc.id },
      { kind: acc.kind, space: 'space' in body ? body.space : 'personal' });
    // Kişisel kaynaklar rıza verilene kadar başlatılmaz.
    if (needsConsent(acc.kind)) {
      await db.query(`UPDATE accounts SET status = 'awaiting_consent', status_at = now() WHERE id = $1`, [acc.id]);
    } else {
      await connectors.start(acc.id);
    }
    return reply.code(201).send({
      id: acc.id, kind: acc.kind, label: acc.label,
      next: needsConsent(acc.kind) ? `POST /accounts/${acc.id}/consent` : null,
    });
  });

  // Aydınlatma metni: rıza vermeden önce herkesin okuduğu metin ve sürümü.
  app.get('/consent-text', async () => getConsentText(db));

  app.put('/consent-text', async (req) => {
    requireAdmin(req);
    const { text } = z.object({ text: z.string().min(20).max(8000) }).parse(req.body);
    const res = await run(() => setConsentText(db, req.user.id, text));
    for (const aid of res.stale) await connectors.stop(aid);
    return res;
  });

  app.get('/settings/retention', async (req) => {
    requireAdmin(req);
    return { company_days: await getCompanyRetention(db) };
  });

  app.put('/settings/retention', async (req) => {
    requireAdmin(req);
    const { days } = z.object({ days: z.number().int().nullable() }).parse(req.body);
    await run(() => setCompanyRetention(db, req.user.id, days));
    return { ok: true };
  });

  app.post('/accounts/:id/consent', async (req) => {
    const { id: aid } = z.object({ id }).parse(req.params);
    await ownAccount(req, aid);
    const { textVersion, ...scope } = scopeSchema.parse(req.body);
    try { await grantConsent(db, aid, req.user.id, scope, { textVersion }); }
    catch (err: any) { throw new HttpError(err.message?.includes('Aydınlatma') ? 409 : 400, err.message); }
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

  // Bağlayıcıyı yeniden başlatır (kopma/hata sonrası).
  app.post('/accounts/:id/restart', async (req) => {
    const { id: aid } = z.object({ id }).parse(req.params);
    await manageableAccount(req, aid);
    await connectors.start(aid);
    return { ok: true };
  });

  app.get('/accounts/:id/qr', async (req) => {
    const { id: aid } = z.object({ id }).parse(req.params);
    const acc = await ownAccount(req, aid);
    if (acc.kind !== 'whatsapp') throw new HttpError(400, 'Yalnız WhatsApp hesapları QR ile eşleşir');
    const qr = connectors.pairingQr(aid);
    return { status: acc.status, qr: qr ? await QRCode.toDataURL(qr, { margin: 1, width: 320 }) : null };
  });

  app.get('/consent-log', async (req) => (await db.query(
    `SELECT account_id, action, scope, purged, text_version, at FROM consent_log
      WHERE user_id = $1 ORDER BY id DESC LIMIT 200`, [req.user.id])).rows);

  // Panelin ana sayfası: yalnız kullanıcının erişebildiği alanlardaki sayılar.
  app.get('/overview', async (req) => {
    const uid = req.user.id;
    const data = await db.asUser(uid, async (tx) => {
      const totals = (await tx.query(
        `SELECT count(*) AS messages, count(DISTINCT m.conversation_id) AS conversations
           FROM messages m JOIN space_members sm ON sm.space_id = m.space_id AND sm.user_id = $1`, [uid])).rows[0]!;
      const bySource = (await tx.query(
        `SELECT a.kind AS source, count(*) AS n FROM messages m
           JOIN space_members sm ON sm.space_id = m.space_id AND sm.user_id = $1
           JOIN conversations c ON c.id = m.conversation_id JOIN accounts a ON a.id = c.account_id
          GROUP BY a.kind ORDER BY n DESC`, [uid])).rows;
      const bySpace = (await tx.query(
        `SELECT s.id, s.kind, s.name, count(m.id) AS n FROM spaces s
           JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = $1
           LEFT JOIN messages m ON m.space_id = s.id GROUP BY s.id ORDER BY s.kind, s.id`, [uid])).rows;
      const daily = (await tx.query(
        `SELECT to_char(date_trunc('day', m.sent_at), 'YYYY-MM-DD') AS day, count(*) AS n FROM messages m
           JOIN space_members sm ON sm.space_id = m.space_id AND sm.user_id = $1
          WHERE m.sent_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`, [uid])).rows;
      return { totals, bySource, bySpace, daily };
    });
    const accounts = await listAccounts(db, { ownerUserId: uid });
    // Hesap sahibi kendi, yönetici şirket botlarının sorunlarını da görür.
    const problems = (await problemAccounts(db, req.user.is_admin ? {} : { ownerUserId: uid }))
      .filter((p) => p.owner_user_id === uid || !['whatsapp', 'email'].includes(p.kind))
      .map(({ id: pid, kind, label, status, status_detail, status_at, last_sync_at }) =>
        ({ id: pid, kind, label, status, status_detail, status_at, last_sync_at }));
    return {
      messages: Number(data.totals.messages), conversations: Number(data.totals.conversations),
      accounts: accounts.length, connected: accounts.filter((a) => a.status === 'connected').length,
      bySource: data.bySource.map((r) => ({ source: r.source, n: Number(r.n) })),
      bySpace: data.bySpace.map((r) => ({ id: Number(r.id), kind: r.kind, name: r.name, n: Number(r.n) })),
      daily: data.daily.map((r) => ({ day: r.day, n: Number(r.n) })),
      problems,
    };
  });

  // Bir kaynağı tamamen kaldırır: durdurur, oturum dosyalarını ve topladığı her şeyi siler.
  app.delete('/accounts/:id', async (req) => {
    const { id: aid } = z.object({ id }).parse(req.params);
    const acc = await ownAccount(req, aid);
    await connectors.stop(aid);
    await revokeConsent(db, aid, req.user.id, { purge: true, sessionDir: connectors.sessionDir(acc.kind, aid) })
      .catch(() => {});
    await db.query('DELETE FROM accounts WHERE id = $1', [aid]);
    if (!needsConsent(acc.kind)) await audit(db, req.user.id, 'account.delete', { type: 'account', id: aid }, { kind: acc.kind });
    return { ok: true };
  });

  // ---------- yönetim ----------
  app.get('/users', async (req) => {
    requireAdmin(req, 'Yalnız yönetici kullanıcıları görür');
    return listUsers(db);
  });

  app.post('/users', async (req, reply) => {
    requireAdmin(req, 'Yalnız yönetici kullanıcı ekler');
    const body = z.object({ name: z.string().min(1), email: z.string().email().optional(), isAdmin: z.boolean().default(false) })
      .parse(req.body);
    const { user, token } = await createUser(db, body, req.user.id);
    return reply.code(201).send({ user, token });
  });

  // Erişim anahtarını yenile (eskisi hemen geçersiz) ya da iptal et.
  app.post('/users/:id/token/reset', async (req) => {
    requireAdmin(req);
    const { id: uid } = z.object({ id }).parse(req.params);
    return { token: await run(() => resetToken(db, uid, req.user.id), 404) };
  });

  app.post('/users/:id/token/revoke', async (req) => {
    requireAdmin(req);
    const { id: uid } = z.object({ id }).parse(req.params);
    await run(() => revokeToken(db, uid, req.user.id), 404);
    return { ok: true };
  });

  // Ayrılan çalışan: devre dışı bırak; kişisel alan silinir ya da devredilir.
  app.post('/users/:id/offboard', async (req) => {
    requireAdmin(req);
    const { id: uid } = z.object({ id }).parse(req.params);
    const body = z.object({ personal: z.enum(['delete', 'transfer']), transferTo: id.optional() }).parse(req.body);
    const accounts = await accountsOf(db, uid);
    for (const a of accounts) await connectors.stop(a.id);
    const result = await run(() => offboardUser(db, req.user.id, uid, body));
    for (const a of result.stopped) {
      await revokeSessionDir(a.kind, a.id);
    }
    for (const bid of result.reassignedBots) await connectors.start(bid).catch(() => {});
    return result;
  });

  const revokeSessionDir = (kind: AccountKind, aid: number) =>
    rm(connectors.sessionDir(kind, aid), { recursive: true, force: true });

  app.get('/audit', async (req) => {
    requireAdmin(req);
    const q = z.object({ before: id.optional(), limit: z.coerce.number().int().optional() }).parse(req.query);
    return listAudit(db, q);
  });

  app.get('/health/connectors', async (req) => {
    requireAdmin(req);
    return { summary: await connectorHealth(db), problems: await problemAccounts(db) };
  });

  // ---------- gizlilik: hariç tutma ve KVKK veri talepleri ----------
  app.get('/exclusions', async (req) => { requireAdmin(req); return listExclusions(db); });

  app.post('/exclusions', async (req, reply) => {
    requireAdmin(req);
    const body = z.object({ identifier: z.string().min(3).max(200), label: z.string().max(120).optional(), purge: z.boolean().default(true) })
      .parse(req.body);
    const res = await run(() => addExclusion(db, req.user.id, body.identifier, { label: body.label, purge: body.purge }));
    return reply.code(201).send(res);
  });

  app.delete('/exclusions/:id', async (req) => {
    requireAdmin(req);
    const { id: eid } = z.object({ id }).parse(req.params);
    await run(() => removeExclusion(db, req.user.id, eid), 404);
    return { ok: true };
  });

  const requestSchema = z.object({ identifier: z.string().min(3).max(200), note: z.string().max(200).optional() });

  // KVKK m.11 erişim talebi. Yönetici de başkasının kişisel alanını okuyamaz (yalnız sayı döner).
  app.post('/data-requests/export', async (req, reply) => {
    limited(sensitiveLimit, req);
    const body = requestSchema.extend({ format: z.enum(['json', 'csv']).default('json') }).parse(req.body);
    const data = await run(() => exportPersonData(db, req.user.id, body.identifier, { note: body.note, asAdmin: req.user.is_admin }));
    if (body.format === 'csv') {
      return reply.type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="veri-talebi-${data.subject_ref}.csv"`).send(personExportCsv(data));
    }
    return data;
  });

  // KVKK m.11 silme talebi: yalnız yönetici; kişisel alanlar dahil her yerden siler. Silinen içerik görüntülenmez.
  app.post('/data-requests/erase', async (req) => {
    requireAdmin(req);
    limited(sensitiveLimit, req);
    const body = requestSchema.extend({ exclude: z.boolean().default(false) }).parse(req.body);
    return run(() => erasePersonData(db, req.user.id, body.identifier, { exclude: body.exclude, note: body.note }));
  });

  return app;
}
