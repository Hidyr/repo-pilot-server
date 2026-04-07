import { eq } from "drizzle-orm"
import { db } from "../db/client"
import { appSettings, features, queueJobs } from "../db/schema"

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.select().from(appSettings).where(eq(appSettings.key, key)).get()
  return row?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } })
    .run()
}

export async function getMaxConcurrentRuns(): Promise<number> {
  const raw = (await getSetting("max_concurrent_runs")) ?? "4"
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return 4
  return Math.min(4, Math.max(1, n))
}

export async function hasActiveWork(): Promise<boolean> {
  const activeQueue = await db
    .select({ id: queueJobs.id })
    .from(queueJobs)
    .where(eq(queueJobs.status, "active"))
    .limit(1)
    .all()
  if (activeQueue.length > 0) return true

  const runningFeature = await db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.status, "in_progress"))
    .limit(1)
    .all()
  return runningFeature.length > 0
}

