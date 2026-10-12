import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { accountSecrets, getAccount, listAccounts, needsConsent, setAccountStatus, type AccountKind } from '../core/accounts.js';
import { ingestMessage } from '../core/ingest.js';
import type { Db } from '../db/client.js';
import { emailConnector } from './email.js';
import { slackConnector } from './slack.js';
import { telegramConnector } from './telegram.js';
import type { Connector, ConnectorFactory } from './types.js';
import { whatsappConnector } from './whatsapp.js';

const factories: Record<AccountKind, ConnectorFactory> = {
  whatsapp: whatsappConnector,
  telegram: telegramConnector,
  slack: slackConnector,
  email: emailConnector,
};

/** Etkin hesapların bağlayıcılarını çalıştırır; hesap eklenip kaldırıldıkça yeniden başlatır. */
export class ConnectorManager {
  private running = new Map<number, Connector>();

  constructor(private db: Db, private appSecret: string, private dataDir: string, private log: Logger) {}

  async startAll(): Promise<void> {
    for (const acc of await listAccounts(this.db, { enabled: true })) {
      await this.start(acc.id).catch((err) => this.log.error({ err, account: acc.id }, 'bağlayıcı başlatılamadı'));
    }
  }

  async start(accountId: number): Promise<void> {
    await this.stop(accountId);
    const account = await getAccount(this.db, accountId);
    if (!account || !account.enabled) return;
    if (needsConsent(account.kind) && !account.consent_at) {
      await setAccountStatus(this.db, account.id, 'awaiting_consent', 'Hesap sahibi rıza vermeden başlatılmaz');
      return;
    }
    const dataDir = join(this.dataDir, account.kind, String(account.id));
    await mkdir(dataDir, { recursive: true });
    const log = this.log.child({ account: account.id, kind: account.kind });
    try {
      const connector = factories[account.kind]({
        db: this.db,
        account,
        secrets: await accountSecrets(this.db, this.appSecret, account.id),
        dataDir,
        log,
        ingest: (msg) => ingestMessage(this.db, account.id, msg),
        setStatus: (status, detail = null) => setAccountStatus(this.db, account.id, status, detail),
      });
      this.running.set(account.id, connector);
      await connector.start();
      log.info('bağlayıcı başladı');
    } catch (err: any) {
      this.running.delete(account.id);
      await setAccountStatus(this.db, account.id, 'error', String(err?.message ?? err));
      throw err;
    }
  }

  async stop(accountId: number): Promise<void> {
    const c = this.running.get(accountId);
    if (!c) return;
    this.running.delete(accountId);
    await c.stop().catch((err) => this.log.warn({ err, account: accountId }, 'bağlayıcı durdurulamadı'));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  /** Bağlayıcıyı durdurur ve oturum klasörünü siler (rıza geri çekilirken). */
  sessionDir(kind: AccountKind, accountId: number): string {
    return join(this.dataDir, kind, String(accountId));
  }

  pairingQr(accountId: number): string | null {
    return this.running.get(accountId)?.pairingQr?.() ?? null;
  }
}
