import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as schema from "./schema"

function computeDefaultDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
  const preferred = join(home, ".repopilot", "repopilot.db")
  const fallback = join(import.meta.dirname, "..", ".repopilot.db")

  try {
    const folder = dirname(preferred)
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    // Quick writability probe (Cursor sandbox may allow read but not write to $HOME).
    writeFileSync(join(folder, ".write-test"), "ok", { encoding: "utf8" })
    return preferred
  } catch {
    return fallback
  }
}

export const DB_PATH = process.env.DB_PATH ?? computeDefaultDbPath()

function ensureDbFolder() {
  const folder = dirname(DB_PATH)
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
}

ensureDbFolder()

export const sqlite = new Database(DB_PATH)
sqlite.exec("PRAGMA foreign_keys = ON;")

export const db = drizzle(sqlite, { schema })

export function now(): string {
  return new Date().toISOString()
}

export function uuid(): string {
  return crypto.randomUUID()
}

/**
 * Self-contained migrations (no drizzle-kit required at runtime).
 * This keeps the dev experience zero-setup while still using Drizzle for queries.
 */
export async function runMigrations(): Promise<void> {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      local_path TEXT NOT NULL,
      is_git_repo INTEGER NOT NULL,
      remote_url TEXT,
      remote_name TEXT,
      default_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      user_prompt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_type TEXT NOT NULL DEFAULT 'fixed',
      runs_per_day INTEGER NOT NULL DEFAULT 1,
      features_per_run INTEGER NOT NULL DEFAULT 1,
      execution_times TEXT,
      git_auto_pull INTEGER NOT NULL DEFAULT 1,
      git_auto_commit INTEGER NOT NULL DEFAULT 1,
      git_auto_push INTEGER NOT NULL DEFAULT 0,
      git_auto_merge INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      command_path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      feature_id TEXT REFERENCES features(id),
      agent_id TEXT,
      status TEXT NOT NULL,
      logs TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      commit_hash TEXT,
      pushed_at TEXT,
      merged_at TEXT,
      queue_position INTEGER
    );

    CREATE TABLE IF NOT EXISTS queue_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      feature_id TEXT NOT NULL,
      run_id TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `)

  // Lightweight "ALTER TABLE ADD COLUMN" migrations for dev upgrades.
  // Bun/SQLite doesn't support many ALTER operations; we only add missing columns.
  const hasColumn = (table: string, column: string): boolean => {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.some((r) => r.name === column)
  }
  const addColumn = (table: string, ddl: string) => {
    // ddl like: "is_git_repo INTEGER NOT NULL DEFAULT 0"
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`)
  }

  if (!hasColumn("projects", "is_git_repo")) addColumn("projects", "is_git_repo INTEGER NOT NULL DEFAULT 0")
  if (!hasColumn("projects", "remote_url")) addColumn("projects", "remote_url TEXT")
  if (!hasColumn("projects", "remote_name")) addColumn("projects", "remote_name TEXT")
  if (!hasColumn("projects", "default_branch")) addColumn("projects", "default_branch TEXT")
  if (!hasColumn("projects", "created_at")) addColumn("projects", "created_at TEXT NOT NULL DEFAULT ''")
  if (!hasColumn("projects", "updated_at")) addColumn("projects", "updated_at TEXT NOT NULL DEFAULT ''")

  if (!hasColumn("features", "user_prompt")) addColumn("features", "user_prompt TEXT")
  if (!hasColumn("features", "created_at")) addColumn("features", "created_at TEXT NOT NULL DEFAULT ''")
  if (!hasColumn("features", "updated_at")) addColumn("features", "updated_at TEXT NOT NULL DEFAULT ''")

  if (!hasColumn("schedules", "git_auto_pull")) addColumn("schedules", "git_auto_pull INTEGER NOT NULL DEFAULT 1")
  if (!hasColumn("schedules", "git_auto_commit")) addColumn("schedules", "git_auto_commit INTEGER NOT NULL DEFAULT 1")
  if (!hasColumn("schedules", "git_auto_push")) addColumn("schedules", "git_auto_push INTEGER NOT NULL DEFAULT 0")
  if (!hasColumn("schedules", "git_auto_merge")) addColumn("schedules", "git_auto_merge INTEGER NOT NULL DEFAULT 0")
  if (!hasColumn("schedules", "created_at")) addColumn("schedules", "created_at TEXT NOT NULL DEFAULT ''")
  if (!hasColumn("schedules", "updated_at")) addColumn("schedules", "updated_at TEXT NOT NULL DEFAULT ''")

  if (!hasColumn("runs", "logs")) addColumn("runs", "logs TEXT")
  if (!hasColumn("runs", "error_message")) addColumn("runs", "error_message TEXT")
  if (!hasColumn("runs", "commit_hash")) addColumn("runs", "commit_hash TEXT")
  if (!hasColumn("runs", "pushed_at")) addColumn("runs", "pushed_at TEXT")
  if (!hasColumn("runs", "merged_at")) addColumn("runs", "merged_at TEXT")
  if (!hasColumn("runs", "queue_position")) addColumn("runs", "queue_position INTEGER")

  if (!hasColumn("queue_jobs", "run_id")) addColumn("queue_jobs", "run_id TEXT")
  if (!hasColumn("queue_jobs", "started_at")) addColumn("queue_jobs", "started_at TEXT")
  if (!hasColumn("queue_jobs", "completed_at")) addColumn("queue_jobs", "completed_at TEXT")
}

export async function seedDefaults(): Promise<void> {
  const defaults: Array<{ key: string; value: string }> = [
    { key: "theme", value: "dark" },
    { key: "autostart", value: "false" },
    { key: "max_concurrent_runs", value: "4" },
    { key: "minimize_to_tray", value: "true" },
  ]

  const insertSetting = sqlite.prepare(
    `INSERT INTO app_settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING;`
  )
  for (const row of defaults) {
    insertSetting.run(row.key, row.value)
  }

  // Seed one enabled agent. We do a "seed-if-empty" (rather than fixed id)
  // so users can add/remove agents freely without us forcing a specific primary key.
  const agentsCount = sqlite
    .prepare("SELECT COUNT(*) as c FROM agents WHERE enabled = 1")
    .get() as { c: number }

  if ((agentsCount?.c ?? 0) > 0) return

  sqlite
    .prepare(
    `INSERT INTO agents (id, name, type, command_path, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING;`
    )
    .run(uuid(), "Cursor CLI", "cursor", "cursor", now(), now())
}

