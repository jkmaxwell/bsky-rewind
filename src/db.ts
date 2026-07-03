import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS post (
  uri TEXT PRIMARY KEY,
  cid TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  is_reply INTEGER NOT NULL DEFAULT 0,
  parent_uri TEXT,
  has_media INTEGER NOT NULL DEFAULT 0,
  has_self_reply INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  repost_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_post_author_time ON post(author, created_at);
CREATE INDEX IF NOT EXISTS idx_post_time ON post(created_at);

-- Likes by accounts in some viewer's follow graph (the "relevant" set).
-- Needed for MagicRecs bursts; aggregate counts live on the post row.
CREATE TABLE IF NOT EXISTS network_like (
  liker TEXT NOT NULL,
  rkey TEXT NOT NULL,
  subject_uri TEXT NOT NULL,
  subject_author TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (liker, rkey)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_nlike_subject ON network_like(subject_uri);
CREATE INDEX IF NOT EXISTS idx_nlike_time ON network_like(created_at);

-- Reposts by relevant accounts, so follows' RTs appear in the timeline.
CREATE TABLE IF NOT EXISTS network_repost (
  reposter TEXT NOT NULL,
  rkey TEXT NOT NULL,
  uri TEXT NOT NULL,
  subject_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (reposter, rkey)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_nrepost_time ON network_repost(created_at);

CREATE TABLE IF NOT EXISTS viewer (
  did TEXT PRIMARY KEY,
  follows_json TEXT,
  follows_fetched_at INTEGER,
  affinity_json TEXT,
  affinity_fetched_at INTEGER,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export type Db = Database.Database

export function openDb(dbPath: string = config.dbPath): Db {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}
