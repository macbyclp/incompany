// Sıralı şema göçleri. Uygulanan sürüm schema_migrations tablosunda tutulur;
// yeni değişiklik her zaman listenin sonuna yeni bir eleman olarak eklenir.
export const migrations: string[] = [
  `
  CREATE TABLE users (
    id          bigserial PRIMARY KEY,
    name        text NOT NULL,
    email       text UNIQUE,
    is_admin    boolean NOT NULL DEFAULT false,
    token_hash  text UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
  );

  -- Hafıza alanları: her kullanıcının tek bir kişisel alanı, şirketin ortak
  -- alanı ve isteğe bağlı ekip alanları.
  CREATE TABLE spaces (
    id             bigserial PRIMARY KEY,
    kind           text NOT NULL CHECK (kind IN ('personal', 'company', 'team')),
    name           text NOT NULL,
    owner_user_id  bigint REFERENCES users(id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'personal') = (owner_user_id IS NOT NULL))
  );
  CREATE UNIQUE INDEX spaces_one_personal ON spaces(owner_user_id) WHERE kind = 'personal';
  CREATE UNIQUE INDEX spaces_one_company ON spaces(kind) WHERE kind = 'company';

  CREATE TABLE space_members (
    space_id  bigint NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
    PRIMARY KEY (space_id, user_id)
  );

  -- Bağlı kaynaklar: bir kullanıcının WhatsApp oturumu, e-posta kutusu ya da
  -- şirketin Telegram/Slack botu. secrets alanı APP_SECRET ile şifrelenir.
  CREATE TABLE accounts (
    id                bigserial PRIMARY KEY,
    kind              text NOT NULL CHECK (kind IN ('whatsapp', 'telegram', 'slack', 'email')),
    owner_user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label             text NOT NULL,
    default_space_id  bigint NOT NULL REFERENCES spaces(id),
    config            jsonb NOT NULL DEFAULT '{}',
    secrets           text,
    status            text NOT NULL DEFAULT 'new',
    status_detail     text,
    enabled           boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE conversations (
    id           bigserial PRIMARY KEY,
    account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    external_id  text NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('dm', 'group', 'channel', 'email')),
    title        text,
    space_id     bigint NOT NULL REFERENCES spaces(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, external_id)
  );

  CREATE TABLE messages (
    id                  bigserial PRIMARY KEY,
    conversation_id     bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    space_id            bigint NOT NULL REFERENCES spaces(id),
    external_id         text NOT NULL,
    sender_external_id  text,
    sender_name         text,
    from_me             boolean NOT NULL DEFAULT false,
    sent_at             timestamptz NOT NULL,
    subject             text,
    body                text NOT NULL,
    raw                 jsonb,
    ingested_at         timestamptz NOT NULL DEFAULT now(),
    tsv tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('turkish', coalesce(subject, '')), 'A') ||
      setweight(to_tsvector('turkish', coalesce(sender_name, '')), 'B') ||
      setweight(to_tsvector('turkish', body), 'C')
    ) STORED,
    UNIQUE (conversation_id, external_id)
  );
  CREATE INDEX messages_tsv ON messages USING gin(tsv);
  CREATE INDEX messages_space_time ON messages(space_id, sent_at DESC);
  `,
  `
  -- Rıza: kişisel kaynaklar (WhatsApp oturumu, e-posta kutusu) hesap sahibi açıkça
  -- onaylamadan çalışmaz. consent_scope: {"dm":"all|selected|none","group":"all|selected|none","history":bool}
  ALTER TABLE accounts
    ADD COLUMN consent_at     timestamptz,
    ADD COLUMN consent_scope  jsonb;

  -- capture=false olan konuşmanın mesajları kaydedilmez ("selected" kipinde sahibi tek tek açar).
  ALTER TABLE conversations ADD COLUMN capture boolean NOT NULL DEFAULT true;

  -- Rıza değişikliklerinin silinmeyen izi: kim, ne zaman, hangi kapsamla.
  CREATE TABLE consent_log (
    id          bigserial PRIMARY KEY,
    account_id  bigint NOT NULL,
    user_id     bigint NOT NULL,
    action      text NOT NULL CHECK (action IN ('grant', 'scope_change', 'revoke')),
    scope       jsonb,
    purged      boolean,
    at          timestamptz NOT NULL DEFAULT now()
  );
  `,
  `
  -- v0.1.4: düzenlenen mesajın içeriği yerinde güncellenir; önceki sürüm saklanmaz.
  ALTER TABLE messages ADD COLUMN edited_at timestamptz;

  -- v0.1.5: "Beni kaydetme" listesi. value, kimlik biçimlerinden biridir (src/core/privacy.ts):
  -- küçük harfli e-posta/kimlik ya da yalnız rakamlardan oluşan telefon numarası.
  CREATE TABLE exclusions (
    id          bigserial PRIMARY KEY,
    value       text NOT NULL UNIQUE,
    label       text,
    created_by  bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );

  -- v0.1.6: ayarlar (aydınlatma metni sürümü, şirket saklama süresi) ve rıza metni sürümü.
  CREATE TABLE settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE accounts ADD COLUMN consent_text_version int;
  UPDATE accounts SET consent_text_version = 1 WHERE consent_at IS NOT NULL;
  ALTER TABLE consent_log ADD COLUMN text_version int;

  -- v0.1.7: devre dışı bırakılan kullanıcı.
  ALTER TABLE users ADD COLUMN disabled_at timestamptz;

  -- v0.1.8: yönetici denetim kaydı. Silinmez; içerik değil, yalnız kim-ne-ne zaman tutulur.
  CREATE TABLE audit_log (
    id             bigserial PRIMARY KEY,
    actor_user_id  bigint,
    action         text NOT NULL,
    target_type    text,
    target_id      text,
    detail         jsonb,
    at             timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX audit_log_at ON audit_log(at DESC);

  -- v0.1.10/11: bağlayıcı sağlığı.
  ALTER TABLE accounts ADD COLUMN last_sync_at timestamptz, ADD COLUMN status_at timestamptz;
  CREATE INDEX conversations_space ON conversations(space_id, id DESC);
  `,
  `
  -- v0.1.9: satır düzeyi güvenlik (savunma derinliği). Uygulama tablo sahibi olarak bağlanır
  -- (RLS atlanır); okuma yolları ise "SET LOCAL ROLE incompany_reader" ile kullanıcının
  -- kimliğinde çalışır ve bu rolün göremeyeceği satırlar veritabanı tarafından süzülür.
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'incompany_reader') THEN
      CREATE ROLE incompany_reader NOLOGIN;
    END IF;
  END $$;
  DO $$ BEGIN
    EXECUTE format('GRANT incompany_reader TO %I', current_user);
  EXCEPTION WHEN others THEN NULL;
  END $$;

  CREATE FUNCTION app_uid() RETURNS bigint LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('app.user_id', true), '')::bigint $$;

  GRANT USAGE ON SCHEMA public TO incompany_reader;
  GRANT EXECUTE ON FUNCTION app_uid() TO incompany_reader;
  GRANT SELECT ON messages, conversations, spaces, space_members TO incompany_reader;
  -- Gizli sütunlar (secrets, token_hash) okuma rolüne hiç verilmez.
  GRANT SELECT (id, kind, owner_user_id, label, default_space_id, config, status, status_detail,
                enabled, consent_at, consent_scope, consent_text_version, last_sync_at, status_at, created_at)
    ON accounts TO incompany_reader;
  GRANT SELECT (id, name, email, is_admin, created_at, disabled_at) ON users TO incompany_reader;

  ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;

  CREATE POLICY spaces_read ON spaces FOR SELECT TO incompany_reader USING (
    id IN (SELECT space_id FROM space_members WHERE user_id = app_uid()));

  CREATE POLICY conversations_read ON conversations FOR SELECT TO incompany_reader USING (
    account_id IN (SELECT id FROM accounts WHERE owner_user_id = app_uid())
    OR (capture AND space_id IN (SELECT space_id FROM space_members WHERE user_id = app_uid())));

  CREATE POLICY messages_read ON messages FOR SELECT TO incompany_reader USING (
    space_id IN (SELECT space_id FROM space_members WHERE user_id = app_uid())
    OR conversation_id IN (SELECT id FROM conversations));
  `,
];
