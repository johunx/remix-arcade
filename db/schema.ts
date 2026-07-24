export const storageSchema = `
CREATE TABLE IF NOT EXISTS storage (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)
`;

export const aiUsageSchema = `
CREATE TABLE IF NOT EXISTS ai_usage (
  bucket TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
)
`;

export const analyticsSchema = `
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name TEXT NOT NULL,
  game_id TEXT,
  viewer_hash TEXT,
  session_id TEXT,
  source TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
)
`;

export const reportsSchema = `
CREATE TABLE IF NOT EXISTS content_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reporter_hash TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
)
`;
