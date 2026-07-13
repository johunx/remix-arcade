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
