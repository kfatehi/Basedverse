-- Visit 0.20: what a visit-client keeps in its database (../../SPEC.md 8.12): the chat its user has had, the
-- pictures shared in it, the links (with their previews), and whom its room keeps out.

-- Every line this office's user has had, theirs too, as their page had it (`line`), by conversation: a room's
-- ("room:<its owner's key>": said in it, or in its chat), a person's ("person:<their key>": whispers), the lobby's.
CREATE TABLE messages (
    id BIGSERIAL PRIMARY KEY,
    at BIGINT NOT NULL,                       -- when it came, ms since 1970
    conversation TEXT NOT NULL,
    scope TEXT NOT NULL,                      -- say, sim (a room's chat), whisper, lobby
    mine BOOLEAN NOT NULL DEFAULT false,
    sender_key TEXT,
    sender_name TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    line JSONB NOT NULL
);
CREATE INDEX messages_at ON messages (at, id);
CREATE INDEX messages_conversation_at ON messages (conversation, at, id);

-- Pictures, by the blake3 hash of their bytes (hex): one copy each, however often shared.
CREATE TABLE media (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    at BIGINT NOT NULL,
    bytes BYTEA NOT NULL
);

-- The pictures in each line, in order (a picture may come after its line: no reference to `media`).
CREATE TABLE message_media (
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    position SMALLINT NOT NULL,
    media_id TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (message_id, position)
);
CREATE INDEX message_media_media ON message_media (media_id);

-- The links in each line, with the preview its sender made (its picture, a media id).
CREATE TABLE links (
    id BIGSERIAL PRIMARY KEY,
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    image_id TEXT
);
CREATE INDEX links_message ON links (message_id);

-- Whom this office's room keeps out of its voice, its chat, or both (8.9), until lifted.
CREATE TABLE bans (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    voice BOOLEAN NOT NULL DEFAULT false,
    chat BOOLEAN NOT NULL DEFAULT false,
    at BIGINT NOT NULL
);
