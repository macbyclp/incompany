-- =============================================================================
--  iNCompany — PostgreSQL 16 Şeması
--  Kurumsal İç Mesajlaşma Platformu
--
--  Uygulama sırası:
--    psql -U postgres -d incompany -f 001_schema.sql
--
--  Konvansiyonlar
--    · Tüm PK'ler UUID v7 (zaman-sıralı → B-tree lokalitesi korunur)
--    · Tüm zaman damgaları TIMESTAMPTZ, UTC
--    · Silme işlemleri mantıksal (deleted_at); fiziksel silme retention worker'da
--    · Çok kiracılı (multi-tenant): her tabloda org_id + Row Level Security
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS citext;      -- büyük/küçük harf duyarsız e-posta
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fallback arama (ILIKE hızlandırma)
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- EXCLUDE kısıtları için

-- UUID v7 üretici (PG18 öncesi için). Zaman-sıralı olması, rastgele UUID v4'e
-- kıyasla index write amplification'ı ciddi biçimde azaltır.
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
LANGUAGE plpgsql
PARALLEL SAFE
AS $$
DECLARE
    unix_ts_ms  bytea;
    uuid_bytes  bytea;
BEGIN
    unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
    uuid_bytes := unix_ts_ms || gen_random_bytes(10);
    -- version 7
    uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
    -- variant RFC 4122
    uuid_bytes := set_byte(uuid_bytes, 8, (b'10'   || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
    RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$;

-- Her tabloda updated_at otomasyonu
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END
$$;

-- =============================================================================
--  ENUM TİPLERİ
-- =============================================================================

CREATE TYPE user_status         AS ENUM ('ACTIVE', 'SUSPENDED', 'DEPROVISIONED');
CREATE TYPE presence_status     AS ENUM ('ONLINE', 'AWAY', 'BUSY', 'DND', 'OFFLINE');
CREATE TYPE channel_type        AS ENUM ('DM', 'GROUP', 'DEPARTMENT', 'ANNOUNCEMENT');
CREATE TYPE channel_visibility  AS ENUM ('PUBLIC', 'PRIVATE');
CREATE TYPE channel_member_role AS ENUM ('OWNER', 'MODERATOR', 'MEMBER', 'READER');
CREATE TYPE message_kind        AS ENUM ('TEXT', 'FILE', 'SYSTEM', 'CALL_EVENT');
CREATE TYPE dlp_action          AS ENUM ('ALLOW', 'MASK', 'WARN', 'BLOCK');
CREATE TYPE av_scan_status      AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'FAILED');
CREATE TYPE audit_outcome       AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- =============================================================================
--  1. ORGANİZASYON (TENANT)
-- =============================================================================

CREATE TABLE organizations (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    slug            citext      NOT NULL UNIQUE,
    display_name    text        NOT NULL,
    -- SSO yapılandırması: {"protocol":"OIDC","issuer":"...","clientId":"..."}
    sso_config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Kurumsal politika: dosya boyutu, izinli MIME, oturum ömrü, MFA zorunluluğu
    policy          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

CREATE TRIGGER trg_organizations_updated
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
--  2. DEPARTMANLAR  (kendine referanslı ağaç)
-- =============================================================================

CREATE TABLE departments (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    parent_id       uuid            NULL REFERENCES departments(id) ON DELETE RESTRICT,
    code            citext      NOT NULL,           -- IK, BT, FIN ... (HRIS ile eşleşir)
    name            text        NOT NULL,
    -- Materialized path: '/root/it/backend/'  → alt ağaç sorgusu tek LIKE ile
    path            text        NOT NULL,
    depth           smallint    NOT NULL DEFAULT 0,
    manager_id      uuid            NULL,           -- FK aşağıda (users'tan sonra)
    -- LDAP/AD senkronizasyon izi
    external_ref    text            NULL,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT departments_org_code_uniq UNIQUE (org_id, code),
    CONSTRAINT departments_no_self_parent CHECK (id <> parent_id),
    CONSTRAINT departments_depth_sane     CHECK (depth BETWEEN 0 AND 12)
);

CREATE INDEX idx_departments_org       ON departments (org_id) WHERE is_active;
CREATE INDEX idx_departments_parent    ON departments (parent_id);
-- Alt ağaç sorgusu: WHERE path LIKE '/root/it/%'
CREATE INDEX idx_departments_path      ON departments (org_id, path text_pattern_ops);

CREATE TRIGGER trg_departments_updated
    BEFORE UPDATE ON departments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
--  3. KULLANICILAR
-- =============================================================================

CREATE TABLE users (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id              uuid          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    department_id       uuid              NULL REFERENCES departments(id) ON DELETE SET NULL,

    email               citext        NOT NULL,
    employee_no         text              NULL,
    display_name        text          NOT NULL,
    title               text              NULL,
    avatar_url          text              NULL,
    locale              text          NOT NULL DEFAULT 'tr-TR',
    timezone            text          NOT NULL DEFAULT 'Europe/Istanbul',

    -- Kimlik sağlayıcı bağı. Salt-SSO kurulumda password_hash NULL kalır.
    idp_subject         text              NULL,   -- OIDC "sub" / SAML NameID
    idp_provider        text              NULL,   -- 'azure-ad' | 'okta' | 'ldap'
    password_hash       text              NULL,   -- Argon2id — yalnızca break-glass hesapları
    mfa_enrolled        boolean       NOT NULL DEFAULT false,

    status              user_status   NOT NULL DEFAULT 'ACTIVE',
    -- Bu değer artırıldığında kullanıcının TÜM erişim token'ları geçersizleşir
    -- (parola değişimi, rol değişimi, güvenlik olayı). JWT içinde "tv" claim'i.
    token_version       integer       NOT NULL DEFAULT 0,

    -- Presence yetkili kaydı Redis'tedir; buradaki alanlar yalnızca kalıcı/manuel durum.
    presence            presence_status NOT NULL DEFAULT 'OFFLINE',
    custom_status_text  text              NULL,
    custom_status_emoji text              NULL,
    custom_status_until timestamptz       NULL,

    last_login_at       timestamptz       NULL,
    last_seen_at        timestamptz       NULL,
    deleted_at          timestamptz       NULL,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT users_org_email_uniq  UNIQUE (org_id, email),
    CONSTRAINT users_email_format    CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT users_status_text_len CHECK (custom_status_text IS NULL OR char_length(custom_status_text) <= 120),
    -- Bir kullanıcının ya IdP bağı ya parolası olmalı; ikisi de yoksa giriş yapamaz.
    CONSTRAINT users_auth_present    CHECK (idp_subject IS NOT NULL OR password_hash IS NOT NULL)
);

CREATE UNIQUE INDEX uq_users_idp_subject
    ON users (org_id, idp_provider, idp_subject)
    WHERE idp_subject IS NOT NULL;

CREATE INDEX idx_users_department ON users (department_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_org_active ON users (org_id) WHERE status = 'ACTIVE' AND deleted_at IS NULL;
-- Kişi arama (mention autocomplete)
CREATE INDEX idx_users_name_trgm  ON users USING gin (display_name gin_trgm_ops);

CREATE TRIGGER trg_users_updated
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Döngüsel bağımlılık nedeniyle geciktirilmiş FK
ALTER TABLE departments
    ADD CONSTRAINT departments_manager_fk
    FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL;

-- =============================================================================
--  4. RBAC — Roller ve İzinler
-- =============================================================================

CREATE TABLE roles (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id        uuid        NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = sistem rolü
    key           citext      NOT NULL,          -- 'ADMIN' | 'DEPT_MANAGER' | 'EMPLOYEE'
    name          text        NOT NULL,
    -- Yüksek rank düşük rank'ı kapsar. Yetki karşılaştırmalarında kullanılır.
    rank          smallint    NOT NULL DEFAULT 0,
    is_system     boolean     NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT roles_key_uniq UNIQUE (org_id, key)
);
-- Sistem rolleri (org_id IS NULL) için ayrı tekillik
CREATE UNIQUE INDEX uq_roles_system_key ON roles (key) WHERE org_id IS NULL;

CREATE TABLE permissions (
    key         citext PRIMARY KEY,    -- 'channel.create' | 'message.delete.any' | 'audit.read'
    description text NOT NULL
);

CREATE TABLE role_permissions (
    role_id        uuid   NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_key citext NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id     uuid        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    -- Rol departman kapsamlı verilebilir: "yalnızca BT departmanının yöneticisi"
    scope_dept_id uuid          NULL REFERENCES departments(id) ON DELETE CASCADE,
    granted_by  uuid            NULL REFERENCES users(id) ON DELETE SET NULL,
    expires_at  timestamptz     NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- NULL kapsamlı (global) rol atamasının tekilliği UNIQUE ile sağlanamaz
-- (NULL <> NULL), bu yüzden iki kısmi indeks kullanılır.
CREATE UNIQUE INDEX uq_user_roles_scoped ON user_roles (user_id, role_id, scope_dept_id)
    WHERE scope_dept_id IS NOT NULL;
CREATE UNIQUE INDEX uq_user_roles_global ON user_roles (user_id, role_id)
    WHERE scope_dept_id IS NULL;
CREATE INDEX idx_user_roles_role ON user_roles (role_id);
CREATE INDEX idx_user_roles_expiry ON user_roles (expires_at) WHERE expires_at IS NOT NULL;

INSERT INTO permissions (key, description) VALUES
    ('channel.create',        'Kanal oluşturma'),
    ('channel.archive',       'Kanal arşivleme'),
    ('channel.member.manage', 'Kanal üyelerini yönetme'),
    ('announcement.post',     'Duyuru kanalına mesaj gönderme'),
    ('message.delete.any',    'Herhangi bir mesajı silme'),
    ('user.manage',           'Kullanıcı oluşturma/askıya alma'),
    ('role.assign',           'Rol atama'),
    ('audit.read',            'Denetim kayıtlarını okuma'),
    ('dlp.manage',            'DLP kurallarını yönetme'),
    ('retention.manage',      'Saklama politikalarını yönetme'),
    ('export.data',           'Veri dışa aktarma / eDiscovery')
ON CONFLICT DO NOTHING;

INSERT INTO roles (id, org_id, key, name, rank, is_system) VALUES
    (uuid_generate_v7(), NULL, 'ADMIN',        'Sistem Yöneticisi',  100, true),
    (uuid_generate_v7(), NULL, 'DEPT_MANAGER', 'Departman Yöneticisi', 50, true),
    (uuid_generate_v7(), NULL, 'EMPLOYEE',     'Çalışan',              10, true)
ON CONFLICT DO NOTHING;

-- ADMIN → tüm izinler
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.key = 'ADMIN' AND r.org_id IS NULL
ON CONFLICT DO NOTHING;

-- DEPT_MANAGER → sınırlı küme
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.key = 'DEPT_MANAGER' AND r.org_id IS NULL
  AND p.key IN ('channel.create','channel.member.manage','announcement.post','channel.archive')
ON CONFLICT DO NOTHING;

-- EMPLOYEE → yalnızca kanal oluşturma
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'channel.create' FROM roles r
WHERE r.key = 'EMPLOYEE' AND r.org_id IS NULL
ON CONFLICT DO NOTHING;

-- =============================================================================
--  5. OTURUM YÖNETİMİ — Refresh Token Rotasyonu
-- =============================================================================

CREATE TABLE refresh_sessions (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Token'ın kendisi ASLA saklanmaz; yalnızca SHA-256 özeti.
    token_hash      bytea       NOT NULL,
    -- Rotasyon zinciri: aynı family içinde eski bir token tekrar kullanılırsa
    -- token hırsızlığı varsayılır ve TÜM aile iptal edilir.
    family_id       uuid        NOT NULL,
    parent_id       uuid            NULL REFERENCES refresh_sessions(id) ON DELETE SET NULL,

    user_agent      text            NULL,
    ip_address      inet            NULL,
    device_label    text            NULL,

    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz     NULL,
    revoked_reason  text            NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT refresh_sessions_hash_uniq UNIQUE (token_hash)
);

CREATE INDEX idx_refresh_user_active ON refresh_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_family      ON refresh_sessions (family_id);
CREATE INDEX idx_refresh_expiry      ON refresh_sessions (expires_at) WHERE revoked_at IS NULL;

-- =============================================================================
--  6. SAKLAMA POLİTİKALARI (Retention)
-- =============================================================================

CREATE TABLE retention_policies (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id              uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                text        NOT NULL,
    message_ttl_days    integer         NULL,   -- NULL = süresiz sakla
    file_ttl_days       integer         NULL,
    -- Yasal muhafaza (legal hold): true ise TTL uygulanmaz.
    legal_hold          boolean     NOT NULL DEFAULT false,
    is_default          boolean     NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT retention_ttl_positive CHECK (
        (message_ttl_days IS NULL OR message_ttl_days > 0) AND
        (file_ttl_days    IS NULL OR file_ttl_days    > 0)
    )
);
CREATE UNIQUE INDEX uq_retention_default ON retention_policies (org_id) WHERE is_default;

-- =============================================================================
--  7. KANALLAR
-- =============================================================================

CREATE TABLE channels (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          uuid               NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    type            channel_type       NOT NULL,
    visibility      channel_visibility NOT NULL DEFAULT 'PRIVATE',

    name            text                   NULL,   -- DM'lerde NULL (isim istemcide üretilir)
    slug            citext                 NULL,
    topic           text                   NULL,
    description     text                   NULL,

    department_id   uuid                   NULL REFERENCES departments(id) ON DELETE CASCADE,

    -- DM tekilliği: iki kullanıcı ID'sinin sıralı SHA-256'sı.
    -- Yarış koşulunda ikinci DM oluşumunu veritabanı seviyesinde engeller.
    dm_key          bytea                  NULL,

    -- Kanal içi monotonik mesaj sayacı. Sıralama ve boşluk tespitinin kaynağı.
    last_seq        bigint             NOT NULL DEFAULT 0,
    last_message_at timestamptz            NULL,

    -- true ise sunucu düz metni ASLA göremez: DLP ve sunucu tarafı arama devre dışı.
    -- Oluşturulduktan sonra değiştirilemez (aşağıdaki trigger).
    e2ee_enabled    boolean            NOT NULL DEFAULT false,
    retention_id    uuid                   NULL REFERENCES retention_policies(id) ON DELETE SET NULL,

    created_by      uuid                   NULL REFERENCES users(id) ON DELETE SET NULL,
    archived_at     timestamptz            NULL,
    created_at      timestamptz        NOT NULL DEFAULT now(),
    updated_at      timestamptz        NOT NULL DEFAULT now(),

    -- Departman kanalı departmana bağlı olmalı; diğerleri olmamalı
    CONSTRAINT channels_department_link CHECK (
        (type = 'DEPARTMENT' AND department_id IS NOT NULL) OR
        (type <> 'DEPARTMENT')
    ),
    -- DM'de isim/slug yok, dm_key zorunlu
    CONSTRAINT channels_dm_shape CHECK (
        (type = 'DM'  AND dm_key IS NOT NULL AND name IS NULL) OR
        (type <> 'DM' AND dm_key IS NULL     AND name IS NOT NULL)
    ),
    CONSTRAINT channels_name_len CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX uq_channels_dm   ON channels (org_id, dm_key) WHERE dm_key IS NOT NULL;
CREATE UNIQUE INDEX uq_channels_slug ON channels (org_id, slug)   WHERE slug IS NOT NULL AND archived_at IS NULL;
CREATE INDEX idx_channels_department ON channels (department_id)  WHERE archived_at IS NULL;
-- Kenar çubuğu sıralaması: en son mesaj alan kanal üstte
CREATE INDEX idx_channels_recent     ON channels (org_id, last_message_at DESC NULLS LAST) WHERE archived_at IS NULL;

CREATE TRIGGER trg_channels_updated
    BEFORE UPDATE ON channels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- E2EE bayrağı geri alınamaz olmalı: açıkken kapatmak, önceki mesajları
-- okunamaz bırakırken kullanıcıya yanlış bir güvenlik izlenimi verir.
CREATE OR REPLACE FUNCTION guard_e2ee_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.e2ee_enabled IS DISTINCT FROM NEW.e2ee_enabled THEN
        RAISE EXCEPTION 'channels.e2ee_enabled degistirilemez (kanal: %)', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_channels_e2ee_immutable
    BEFORE UPDATE ON channels
    FOR EACH ROW EXECUTE FUNCTION guard_e2ee_immutable();

-- ---------------------------------------------------------------------------
--  Kanal Veri Anahtarları (DEK) — zarf şifreleme
--  Düz DEK burada DEĞİLDİR: Vault/KMS'teki KEK ile sarmalanmış hali saklanır.
-- ---------------------------------------------------------------------------
CREATE TABLE channel_keys (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    channel_id      uuid        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    version         integer     NOT NULL DEFAULT 1,
    wrapped_dek     bytea       NOT NULL,      -- KMS/Vault ile sarmalanmış 32 baytlık anahtar
    kek_id          text        NOT NULL,      -- Hangi master anahtarın sarmaladığı
    algorithm       text        NOT NULL DEFAULT 'AES-256-GCM',
    is_active       boolean     NOT NULL DEFAULT true,
    rotated_at      timestamptz     NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT channel_keys_version_uniq UNIQUE (channel_id, version)
);
-- Kanal başına yalnızca bir aktif anahtar
CREATE UNIQUE INDEX uq_channel_keys_active ON channel_keys (channel_id) WHERE is_active;

-- =============================================================================
--  8. KANAL ÜYELİKLERİ
-- =============================================================================

CREATE TABLE channel_members (
    channel_id      uuid                NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id         uuid                NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    role            channel_member_role NOT NULL DEFAULT 'MEMBER',

    -- Okundu bilgisi yüksek-su-seviyesi olarak. Mesaj başına satır TUTULMAZ:
    -- 200 üyeli × 1000 mesajlı kanal = 200 satır (200.000 değil).
    last_read_seq       bigint      NOT NULL DEFAULT 0,
    last_delivered_seq  bigint      NOT NULL DEFAULT 0,
    last_read_at        timestamptz     NULL,

    is_muted        boolean     NOT NULL DEFAULT false,
    muted_until     timestamptz     NULL,
    is_pinned       boolean     NOT NULL DEFAULT false,
    notify_level    text        NOT NULL DEFAULT 'ALL',   -- ALL | MENTIONS | NONE

    joined_at       timestamptz NOT NULL DEFAULT now(),
    left_at         timestamptz     NULL,
    invited_by      uuid            NULL REFERENCES users(id) ON DELETE SET NULL,

    PRIMARY KEY (channel_id, user_id),
    CONSTRAINT channel_members_seq_order CHECK (last_read_seq <= last_delivered_seq),
    CONSTRAINT channel_members_notify CHECK (notify_level IN ('ALL','MENTIONS','NONE'))
);

-- "Kullanıcının kanalları" — kenar çubuğu için en sık sorgu
CREATE INDEX idx_channel_members_user ON channel_members (user_id) WHERE left_at IS NULL;
-- Okunmamış mesajı olan kanallar (kısmi indeks → çok küçük kalır)
CREATE INDEX idx_channel_members_unread ON channel_members (user_id, channel_id)
    WHERE left_at IS NULL AND last_read_seq < last_delivered_seq;

-- =============================================================================
--  9. MESAJLAR  (aylık RANGE partition)
--
--  Neden partition?
--    · Retention = DROP PARTITION (saniyeler) vs DELETE (saatler + VACUUM yükü)
--    · Sorgular çoğunlukla son 30 güne bakar → partition pruning
--    · Eski partition'lar daha ucuz depolamaya taşınabilir (tablespace)
-- =============================================================================

CREATE TABLE messages (
    id              uuid           NOT NULL DEFAULT uuid_generate_v7(),
    org_id          uuid           NOT NULL,
    channel_id      uuid           NOT NULL,
    sender_id       uuid               NULL,   -- SYSTEM mesajlarında NULL
    kind            message_kind   NOT NULL DEFAULT 'TEXT',

    -- Kanal içi monotonik sıra. Sıralama ve boşluk tespitinin tek kaynağı.
    seq             bigint         NOT NULL,

    -- İstemci tarafından üretilen idempotency anahtarı (UUID).
    -- Ağ kopmasında yapılan yeniden gönderim çift mesaj oluşturmaz.
    client_msg_id   uuid           NOT NULL,

    -- ŞİFRELİ GÖVDE — düz metin bu sütunda ASLA bulunmaz.
    ciphertext      bytea          NOT NULL,
    iv              bytea          NOT NULL,   -- 12 bayt, GCM nonce
    auth_tag        bytea          NOT NULL,   -- 16 bayt, GCM doğrulama etiketi
    key_version     integer        NOT NULL DEFAULT 1,
    cipher_scheme   smallint       NOT NULL DEFAULT 1,   -- 1 = AES-256-GCM/envelope

    -- Şifresiz metadata (arama, bildirim ve sıralama için gerekli asgari küme)
    reply_to_id     uuid               NULL,
    thread_root_id  uuid               NULL,
    mentions        uuid[]         NOT NULL DEFAULT '{}',
    has_attachment  boolean        NOT NULL DEFAULT false,
    -- DLP sonucu: {"action":"MASK","rules":["TCKN"],"maskedSpans":2}
    dlp_verdict     jsonb              NULL,

    edited_at       timestamptz        NULL,
    deleted_at      timestamptz        NULL,
    deleted_by      uuid               NULL,
    created_at      timestamptz    NOT NULL DEFAULT now(),

    PRIMARY KEY (created_at, channel_id, seq),

    CONSTRAINT messages_seq_positive CHECK (seq > 0),
    CONSTRAINT messages_iv_len       CHECK (octet_length(iv) = 12),
    CONSTRAINT messages_tag_len      CHECK (octet_length(auth_tag) = 16),
    CONSTRAINT messages_body_size    CHECK (octet_length(ciphertext) <= 65536),
    CONSTRAINT messages_sender_req   CHECK (kind = 'SYSTEM' OR sender_id IS NOT NULL)
) PARTITION BY RANGE (created_at);

-- Sıralı okuma: WHERE channel_id = ? ORDER BY seq DESC LIMIT 50
CREATE INDEX idx_messages_channel_seq ON messages (channel_id, seq DESC);
CREATE INDEX idx_messages_id          ON messages (id);
-- İdempotency ikinci savunma hattı.
--
-- DİKKAT: PostgreSQL'de bölümlenmiş bir tablo üzerindeki UNIQUE indeks, bölümleme
-- anahtarını (created_at) İÇERMEK ZORUNDADIR. created_at eklendiğinde ise kısıt
-- pratikte işe yaramaz hale gelir (iki yeniden gönderim farklı mikrosaniyelerde olur).
-- Bu yüzden birincil idempotency kontrolü Redis'te SET NX + 5 dk TTL ile yapılır
-- (bkz. chat.service.ts → claimIdempotency). Buradaki indeks yalnızca tespit ve
-- mutabakat (reconciliation) sorguları içindir.
CREATE INDEX idx_messages_client_id ON messages (channel_id, sender_id, client_msg_id);
CREATE INDEX idx_messages_thread      ON messages (thread_root_id, seq) WHERE thread_root_id IS NOT NULL;
CREATE INDEX idx_messages_mentions    ON messages USING gin (mentions) WHERE mentions <> '{}';

-- Aylık partition'lar. Üretimde pg_partman ile otomatik üretilir.
CREATE TABLE messages_2026_08 PARTITION OF messages FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE messages_2026_09 PARTITION OF messages FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE messages_2026_10 PARTITION OF messages FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
-- Aralık dışı yazımların hata vermesi yerine yakalanması için varsayılan partition
CREATE TABLE messages_default PARTITION OF messages DEFAULT;

-- ---------------------------------------------------------------------------
--  Sıra numarası atama — yarış koşulu güvenli
--  UPDATE ... RETURNING satır kilidi alır; aynı kanala eşzamanlı iki gönderim
--  serileşir ve asla aynı seq'i almaz.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION next_channel_seq(p_channel_id uuid)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
    v_seq bigint;
BEGIN
    UPDATE channels
       SET last_seq        = last_seq + 1,
           last_message_at = now()
     WHERE id = p_channel_id
       AND archived_at IS NULL
    RETURNING last_seq INTO v_seq;

    IF v_seq IS NULL THEN
        RAISE EXCEPTION 'Kanal bulunamadi veya arsivlenmis: %', p_channel_id
            USING ERRCODE = 'no_data_found';
    END IF;

    RETURN v_seq;
END
$$;

-- =============================================================================
--  10. EKLER VE TEPKİLER
-- =============================================================================

CREATE TABLE attachments (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          uuid           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    channel_id      uuid           NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    uploader_id     uuid               NULL REFERENCES users(id) ON DELETE SET NULL,

    storage_key     text           NOT NULL UNIQUE,     -- S3 nesne anahtarı
    file_name       text           NOT NULL,
    mime_type       text           NOT NULL,
    size_bytes      bigint         NOT NULL,
    checksum_sha256 bytea          NOT NULL,

    av_status       av_scan_status NOT NULL DEFAULT 'PENDING',
    av_scanned_at   timestamptz        NULL,
    av_signature    text               NULL,
    dlp_verdict     jsonb              NULL,

    expires_at      timestamptz        NULL,            -- retention worker bunu kullanır
    deleted_at      timestamptz        NULL,
    created_at      timestamptz    NOT NULL DEFAULT now(),

    CONSTRAINT attachments_size_positive CHECK (size_bytes > 0),
    CONSTRAINT attachments_checksum_len  CHECK (octet_length(checksum_sha256) = 32)
);

CREATE INDEX idx_attachments_channel ON attachments (channel_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_attachments_expiry  ON attachments (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_attachments_av      ON attachments (av_status)  WHERE av_status = 'PENDING';

CREATE TABLE message_attachments (
    message_id    uuid NOT NULL,
    attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE message_reactions (
    message_id  uuid        NOT NULL,
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (message_id, user_id, emoji),
    CONSTRAINT reactions_emoji_len CHECK (char_length(emoji) BETWEEN 1 AND 32)
);

-- =============================================================================
--  11. DLP — Kurallar ve Olaylar
-- =============================================================================

CREATE TABLE dlp_rules (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    key             citext      NOT NULL,       -- 'TCKN' | 'CREDIT_CARD' | 'API_KEY' | 'IBAN'
    name            text        NOT NULL,
    pattern         text        NOT NULL,       -- RE2 uyumlu regex (katastrofik geri izleme yok)
    -- Regex sonrası çalışan doğrulayıcı: 'luhn' | 'tckn' | 'iban_mod97' | NULL
    validator       text            NULL,
    action          dlp_action  NOT NULL DEFAULT 'MASK',
    severity        smallint    NOT NULL DEFAULT 3,
    -- Belirli kanal tiplerinde farklı davranış: {"channelTypes":["ANNOUNCEMENT"]}
    applies_to      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT dlp_rules_key_uniq  UNIQUE (org_id, key),
    CONSTRAINT dlp_rules_severity  CHECK (severity BETWEEN 1 AND 5)
);

CREATE TABLE dlp_incidents (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          uuid        NOT NULL,
    rule_id         uuid            NULL REFERENCES dlp_rules(id) ON DELETE SET NULL,
    rule_key        citext      NOT NULL,       -- kural silinse de kalıcı iz
    user_id         uuid            NULL REFERENCES users(id) ON DELETE SET NULL,
    channel_id      uuid            NULL,
    message_id      uuid            NULL,
    action_taken    dlp_action  NOT NULL,
    match_count     integer     NOT NULL DEFAULT 1,
    -- Hassas verinin KENDİSİ saklanmaz. Yalnızca ilk/son 2 karakter + uzunluk.
    -- İhlali kanıtlamak için yeterli, ikinci bir sızıntı kaynağı olmamak için asgari.
    redacted_sample text            NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dlp_incidents_user ON dlp_incidents (user_id, created_at DESC);
CREATE INDEX idx_dlp_incidents_rule ON dlp_incidents (org_id, rule_key, created_at DESC);

-- =============================================================================
--  12. DENETİM KAYITLARI (Audit Trail)
--  Ekle-yalnız (append-only) + hash zinciri ile kurcalama tespiti.
-- =============================================================================

CREATE TABLE audit_logs (
    id              uuid           NOT NULL DEFAULT uuid_generate_v7(),
    org_id          uuid           NOT NULL,

    actor_id        uuid               NULL,     -- sistem işlemlerinde NULL
    actor_email     citext             NULL,     -- kullanıcı silinse de kalıcı iz
    impersonated_by uuid               NULL,     -- destek personeli taklidi

    action          text           NOT NULL,     -- 'auth.login' | 'file.download' | 'role.assign'
    resource_type   text           NOT NULL,     -- 'user' | 'channel' | 'message'
    resource_id     text               NULL,
    outcome         audit_outcome  NOT NULL DEFAULT 'SUCCESS',

    ip_address      inet               NULL,
    user_agent      text               NULL,
    session_id      uuid               NULL,
    trace_id        text               NULL,     -- OpenTelemetry korelasyonu

    -- Değişiklik farkı: {"before":{"role":"EMPLOYEE"},"after":{"role":"ADMIN"}}
    metadata        jsonb          NOT NULL DEFAULT '{}'::jsonb,

    -- Kurcalama tespiti: bu kaydın hash'i bir öncekini içerir.
    -- Zincirdeki bir kaydın değiştirilmesi sonraki tüm hash'leri geçersiz kılar.
    prev_hash       bytea              NULL,
    record_hash     bytea          NOT NULL,

    created_at      timestamptz    NOT NULL DEFAULT now(),

    PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_audit_actor    ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_action   ON audit_logs (org_id, action, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_failures ON audit_logs (org_id, created_at DESC) WHERE outcome <> 'SUCCESS';

CREATE TABLE audit_logs_2026_08 PARTITION OF audit_logs FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE audit_logs_2026_09 PARTITION OF audit_logs FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

-- Değiştirme ve silmeyi VERİTABANI seviyesinde engelle.
-- Uygulama kodundaki bir hata veya ele geçirilmiş bir uygulama hesabı
-- denetim izini bozamaz.
CREATE OR REPLACE FUNCTION audit_logs_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs ekle-yalniz bir tablodur: % islemi reddedildi', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();

-- Hash zincirini otomatik hesapla.
--
-- MALİYET NOTU: Bu tetikleyici her INSERT için bir SELECT yapar ve org başına
-- denetim yazımlarını fiilen serileştirir. Denetim hacmi mesaj hacminden 2-3 kat
-- düşük olduğu için (org başına ~50-200 olay/sn) bu kabul edilebilir bir
-- takastır; kurcalama tespiti, yazım verimliliğinden daha değerlidir.
-- Bu sınıra dayanırsanız: zinciri kaldırın, kayıtları outbox üzerinden WORM
-- depoya (S3 Object Lock) akıtın ve zinciri orada toplu (batch) hesaplayın.
CREATE OR REPLACE FUNCTION audit_logs_chain()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_prev bytea;
BEGIN
    SELECT record_hash INTO v_prev
      FROM audit_logs
     WHERE org_id = NEW.org_id
     ORDER BY created_at DESC, id DESC
     LIMIT 1;

    NEW.prev_hash   := v_prev;
    NEW.record_hash := digest(
        coalesce(encode(v_prev, 'hex'), '') ||
        NEW.id::text || NEW.org_id::text || coalesce(NEW.actor_id::text, '') ||
        NEW.action || NEW.resource_type || coalesce(NEW.resource_id, '') ||
        NEW.outcome::text || NEW.metadata::text || NEW.created_at::text,
        'sha256'
    );
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_audit_chain BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_chain();

-- =============================================================================
--  13. TRANSACTIONAL OUTBOX
--  Mesaj yazımı ile arama indeksleme / bildirim / analitik yayını arasında
--  atomiklik sağlar. "DB'ye yazdım ama Kafka'ya yazamadım" durumunu ortadan kaldırır.
-- =============================================================================

CREATE TABLE outbox_events (
    id            bigserial PRIMARY KEY,
    aggregate_type text        NOT NULL,        -- 'message' | 'channel' | 'user'
    aggregate_id   uuid        NOT NULL,
    event_type     text        NOT NULL,        -- 'message.created'
    payload        jsonb       NOT NULL,
    published_at   timestamptz     NULL,
    attempts       smallint    NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Yayınlanmamış olaylar — kısmi indeks sayesinde tablo büyüse de indeks küçük kalır
CREATE INDEX idx_outbox_pending ON outbox_events (id) WHERE published_at IS NULL;

-- =============================================================================
--  14. ROW LEVEL SECURITY — Kiracı İzolasyonu
--  Uygulamadaki bir "WHERE org_id" unutulması veri sızıntısına dönüşmesin.
-- =============================================================================

ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments     ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_users ON users
    USING (org_id = current_setting('app.current_org', true)::uuid);
CREATE POLICY tenant_isolation_departments ON departments
    USING (org_id = current_setting('app.current_org', true)::uuid);
CREATE POLICY tenant_isolation_channels ON channels
    USING (org_id = current_setting('app.current_org', true)::uuid);
CREATE POLICY tenant_isolation_messages ON messages
    USING (org_id = current_setting('app.current_org', true)::uuid);
CREATE POLICY tenant_isolation_audit ON audit_logs
    USING (org_id = current_setting('app.current_org', true)::uuid);
CREATE POLICY tenant_isolation_attachments ON attachments
    USING (org_id = current_setting('app.current_org', true)::uuid);

-- Uygulama rolü: DDL yok, audit'te yalnızca INSERT/SELECT
CREATE ROLE incompany_app NOLOGIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO incompany_app;
REVOKE UPDATE, DELETE ON audit_logs FROM incompany_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO incompany_app;

-- =============================================================================
--  15. YARDIMCI GÖRÜNÜMLER
-- =============================================================================

-- Kenar çubuğu: kullanıcının kanalları + okunmamış sayısı, tek sorguda
CREATE OR REPLACE VIEW v_user_channel_overview AS
SELECT
    cm.user_id,
    c.id                                        AS channel_id,
    c.type,
    c.name,
    c.last_seq,
    c.last_message_at,
    cm.last_read_seq,
    GREATEST(c.last_seq - cm.last_read_seq, 0)  AS unread_count,
    cm.is_muted,
    cm.is_pinned,
    cm.notify_level
FROM channel_members cm
JOIN channels c ON c.id = cm.channel_id
WHERE cm.left_at IS NULL
  AND c.archived_at IS NULL;

COMMIT;

-- =============================================================================
--  BAKIM NOTLARI
--
--  Aylık partition üretimi (üretimde pg_partman ile otomatik):
--    CREATE TABLE messages_2026_11 PARTITION OF messages
--        FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
--
--  Retention uygulaması — DELETE değil DROP:
--    ALTER TABLE messages DETACH PARTITION messages_2025_08 CONCURRENTLY;
--    DROP TABLE messages_2025_08;
--
--  Denetim zinciri doğrulama (planlı görev):
--    SELECT id, created_at FROM audit_logs a
--    WHERE a.prev_hash IS DISTINCT FROM (
--        SELECT record_hash FROM audit_logs b
--        WHERE b.org_id = a.org_id AND (b.created_at, b.id) < (a.created_at, a.id)
--        ORDER BY b.created_at DESC, b.id DESC LIMIT 1
--    );
-- =============================================================================
