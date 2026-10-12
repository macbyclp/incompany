import type { Logger } from 'pino';
import type { Account } from '../core/accounts.js';
import type { Db } from '../db/client.js';
import type { IncomingMessage } from '../core/ingest.js';

export interface ConnectorContext {
  db: Db;
  account: Account;
  secrets: Record<string, string>;
  /** Bağlayıcının kalıcı dosya saklayabileceği hesaba özel klasör. */
  dataDir: string;
  log: Logger;
  ingest(msg: IncomingMessage): Promise<boolean>;
  setStatus(status: string, detail?: string | null): Promise<void>;
}

export interface Connector {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** WhatsApp eşleştirmesi bekliyorsa güncel QR verisi. */
  pairingQr?(): string | null;
}

export type ConnectorFactory = (ctx: ConnectorContext) => Connector;
