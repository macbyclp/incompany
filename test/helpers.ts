import { beforeAll, beforeEach } from 'vitest';
import type { Db } from '../src/db/client.js';
import { pgliteDb } from '../src/db/pglite.js';
import { createUser, ensureCompanySpace } from '../src/core/users.js';
import type { IncomingMessage } from '../src/core/ingest.js';

export const SECRET = 'x'.repeat(32);

const TABLES = 'audit_log, consent_log, exclusions, settings, messages, conversations, space_members, accounts, spaces, users';

/**
 * Dosya başına tek bir bellek içi Postgres kurar (kurulum pahalıdır) ve her testten önce tabloları boşaltır.
 * Döndürülen nesne `db` alanıyla her testte güncel veritabanına erişir.
 */
export function useDb() {
  const ctx = { db: undefined as unknown as Db };
  beforeAll(async () => { ctx.db = await pgliteDb(); });
  beforeEach(async () => { await ctx.db.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`); });
  return ctx;
}

/** Şirket alanı + yönetici (Ali) + üye (Veli) + üye (Ayşe). */
export async function seedPeople(db: Db) {
  const company = await ensureCompanySpace(db);
  const ali = await createUser(db, { name: 'Ali', isAdmin: true });
  const veli = await createUser(db, { name: 'Veli' });
  const ayse = await createUser(db, { name: 'Ayşe' });
  return { company, ali, veli, ayse };
}

export const msg = (
  kind: IncomingMessage['conversation']['kind'], conv: string, id: string, body: string, extra: Partial<IncomingMessage> = {},
): IncomingMessage => ({ conversation: { externalId: conv, kind, title: conv }, externalId: id, sentAt: new Date(), body, ...extra });

export const count = async (db: Db, table = 'messages') =>
  Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);
