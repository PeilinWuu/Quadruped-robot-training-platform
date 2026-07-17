import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const dbPath = resolve(process.env.AUTH_DB_PATH ?? 'data/auth.sqlite')
mkdirSync(dirname(dbPath), { recursive: true })

export const db = new DatabaseSync(dbPath)
// WAL 允许读写更好地并发；外键保证删除用户时关联会话一并清理。
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'operator',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
`)

export interface DbUser {
  // 此类型对应数据库字段；返回前端前会转换为不含 password_hash 的公开用户对象。
  id: number; username: string; email: string; display_name: string; password_hash: string; role: string; created_at: string
}
