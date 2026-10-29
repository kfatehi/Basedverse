-- Visit 0.22.0: the mailbox (../../SPEC.md 8.9): which lines its user has not seen yet; and whispers kept for someone
-- away, until they and this office are both in the lobby.

-- A line meant for its user (a whisper, a line in their room's chat, a line that mentions them) that came while
-- nobody was looking at its chat: unseen, until its user has seen it.
ALTER TABLE messages ADD COLUMN unseen BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX messages_unseen ON messages (conversation, at, id) WHERE unseen;

-- Whispers this office's user left for someone not in the lobby (by their key): passed on through the lobby once
-- they and this office are both in it, then gone from here.
CREATE TABLE held (
    id TEXT PRIMARY KEY,
    to_key TEXT NOT NULL,
    to_name TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    at BIGINT NOT NULL
);
CREATE INDEX held_to ON held (to_key, at);
