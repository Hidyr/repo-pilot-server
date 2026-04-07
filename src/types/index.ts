export type Project = {
  id: string
  name: string
  description: string | null
  localPath: string
  isGitRepo: boolean
  remoteUrl: string | null
  remoteName: string | null
  defaultBranch: string | null
  createdAt: string
  updatedAt: string
}

export type FeatureStatus = "pending" | "queued" | "in_progress" | "done" | "failed"

export type Feature = {
  id: string
  projectId: string
  title: string
  description: string | null
  userPrompt: string | null
  status: FeatureStatus
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type Schedule = {
  id: string
  projectId: string
  enabled: boolean
  intervalType: "fixed" | "random"
  runsPerDay: number
  featuresPerRun: number
  executionTimes: string | null // JSON string ["09:00", ...]
  gitAutoPull: boolean
  gitAutoCommit: boolean
  gitAutoPush: boolean
  gitAutoMerge: boolean
  createdAt: string
  updatedAt: string
}

export type AgentType = "cursor" | "claude-code" | "custom"

export type Agent = {
  id: string
  name: string
  type: AgentType
  commandPath: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type RunStatus = "queued" | "running" | "success" | "failed" | "skipped"

export type Run = {
  id: string
  projectId: string
  featureId: string | null
  agentId: string | null
  status: RunStatus
  logs: string | null
  errorMessage: string | null
  startedAt: string
  completedAt: string | null
  commitHash: string | null
  pushedAt: string | null
  mergedAt: string | null
  queuePosition: number | null
}

export type QueueJobStatus = "waiting" | "active" | "done" | "failed"

export type QueueJob = {
  id: string
  projectId: string
  featureId: string
  runId: string | null
  status: QueueJobStatus
  priority: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export type ApiError = { error: { code: string; message: string } }

