import { sqlite } from "../db/client"

export type QueueSnapshot = {
  maxSlots: number
  activeSlots: number
  waitingCount: number
  jobs: Array<{
    id: string
    projectId: string
    projectName: string
    featureId: string
    featureTitle: string
    status: "waiting" | "active"
    priority: number
    createdAt: string
    startedAt?: string
  }>
}

export async function queueSnapshot(): Promise<QueueSnapshot> {
  const maxRaw = (sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(
    "max_concurrent_runs"
  ) as { value?: string } | undefined)?.value
  const maxSlots = Math.min(4, Math.max(1, Number.parseInt(maxRaw ?? "4", 10) || 4))

  const rows = sqlite
    .prepare(
      `
      SELECT
        q.id as id,
        q.project_id as projectId,
        p.name as projectName,
        q.feature_id as featureId,
        f.title as featureTitle,
        q.status as status,
        q.priority as priority,
        q.created_at as createdAt,
        q.started_at as startedAt
      FROM queue_jobs q
      JOIN projects p ON p.id = q.project_id
      JOIN features f ON f.id = q.feature_id
      WHERE q.status IN ('waiting', 'active')
      ORDER BY q.status = 'active' DESC, q.priority DESC, q.created_at ASC
    `
    )
    .all() as Array<any>

  const jobs = rows.map((r) => ({
    id: String(r.id),
    projectId: String(r.projectId),
    projectName: String(r.projectName),
    featureId: String(r.featureId),
    featureTitle: String(r.featureTitle),
    status: r.status === "active" ? "active" : "waiting",
    priority: Number(r.priority ?? 0),
    createdAt: String(r.createdAt),
    ...(r.startedAt ? { startedAt: String(r.startedAt) } : {}),
  }))

  const activeSlots = jobs.filter((j) => j.status === "active").length
  const waitingCount = jobs.filter((j) => j.status === "waiting").length

  return { maxSlots, activeSlots, waitingCount, jobs }
}

