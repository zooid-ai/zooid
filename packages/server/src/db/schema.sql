CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT,
  is_public INTEGER NOT NULL DEFAULT 1,
  schema TEXT,
  strict INTEGER NOT NULL DEFAULT 0,
  max_subscribers INTEGER DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  publisher_id TEXT,
  type TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  url TEXT NOT NULL,
  event_types TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE TABLE IF NOT EXISTS publishers (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE TABLE IF NOT EXISTS server_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'Zooid',
  description TEXT,
  tags TEXT,
  owner TEXT,
  company TEXT,
  email TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_channel_created ON events(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_channel_type ON events(channel_id, type);
CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks(channel_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_channel_url ON webhooks(channel_id, url);
CREATE INDEX IF NOT EXISTS idx_publishers_channel ON publishers(channel_id);
