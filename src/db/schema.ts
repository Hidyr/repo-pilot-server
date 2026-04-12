import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  localPath: text("local_path").notNull(),
  isGitRepo: integer("is_git_repo", { mode: "boolean" }).notNull(),
  remoteUrl: text("remote_url"),
  remoteName: text("remote_name"),
  defaultBranch: text("default_branch"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const features = sqliteTable("features", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  userPrompt: text("user_prompt"),
  status: text("status").notNull().default("pending"),
  /** When true, automation and manual queue runs skip this feature until unfrozen. */
  frozen: integer("frozen", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  agentId: text("agent_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  intervalType: text("interval_type").notNull().default("fixed"),
  runsPerDay: integer("runs_per_day").notNull().default(1),
  featuresPerRun: integer("features_per_run").notNull().default(1),
  executionTimes: text("execution_times"),
  gitAutoPull: integer("git_auto_pull", { mode: "boolean" }).notNull().default(true),
  gitAutoCommit: integer("git_auto_commit", { mode: "boolean" }).notNull().default(false),
  gitAutoPush: integer("git_auto_push", { mode: "boolean" }).notNull().default(false),
  gitAutoMerge: integer("git_auto_merge", { mode: "boolean" }).notNull().default(false),
  /** `current` | `from_base` | `branch` — how to pick the working tree before the agent runs */
  gitRunStartMode: text("git_run_start_mode").notNull().default("current"),
  /** When `gitRunStartMode` is `branch`, checkout this local branch before the run */
  gitRunBranch: text("git_run_branch"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  preset: text("preset").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  lastTestOk: integer("last_test_ok", { mode: "boolean" }).notNull().default(false),
  lastTestedAt: text("last_tested_at"),
  lastTestOutput: text("last_test_output"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  featureId: text("feature_id").references(() => features.id),
  agentId: text("agent_id"),
  status: text("status").notNull(),
  logs: text("logs"),
  errorMessage: text("error_message"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  commitHash: text("commit_hash"),
  pushedAt: text("pushed_at"),
  mergedAt: text("merged_at"),
  queuePosition: integer("queue_position"),
})

export const queueJobs = sqliteTable("queue_jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  featureId: text("feature_id").notNull(),
  runId: text("run_id"),
  status: text("status").notNull(),
  priority: integer("priority").notNull().default(0),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
})

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
})

