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
];
