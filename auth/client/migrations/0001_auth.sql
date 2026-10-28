-- auth-client's schema (../SPEC.md 5), in its own schema `auth`, owned by its own role (`auth-client migrate
-- --admin` makes both): visit-client's role has no rights to it, so a fault there cannot read a password hash.

-- The accounts: made in a terminal (auth-client user add), never in a browser. Every user is an owner.
CREATE TABLE auth.users (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                TEXT NOT NULL,
    password_hash       TEXT NOT NULL,                 -- Argon2id, in the PHC string format (its parameters in it)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_name ON auth.users (lower(name));

-- Signed-in sessions, by their id's SHA-256 only: a copy of the database holds no live session.
CREATE TABLE auth.sessions (
    id_hash        BYTEA PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),   -- written at most once a minute
    expires_at     TIMESTAMPTZ NOT NULL,                 -- its whole life's end; unused for the idle time, it ends sooner
    client_address TEXT,
    user_agent     TEXT
);
CREATE INDEX sessions_user ON auth.sessions (user_id);

-- API keys for the owner's scripts and agents, by their SHA-256 only. A label is used again once its key is revoked.
CREATE TABLE auth.api_keys (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label        TEXT NOT NULL,
    key_hash     BYTEA NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX api_keys_label ON auth.api_keys (label) WHERE revoked_at IS NULL;

-- Every sign-in tried: for `auth-client sessions`, an audit, and slowing down guesses (`waited`: turned away
-- unchecked, it was too soon after the last wrong one).
CREATE TABLE auth.login_attempts (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_name      TEXT NOT NULL,
    client_address TEXT,
    ok             BOOLEAN NOT NULL,
    waited         BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX login_attempts_name ON auth.login_attempts (lower(user_name), at);
CREATE INDEX login_attempts_address ON auth.login_attempts (client_address, at);
