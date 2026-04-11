import { eq } from "drizzle-orm"
import { db, now, uuid } from "../db/client"
import { schedules } from "../db/schema"
import type { Schedule } from "../types"

export async function getScheduleForProject(projectId: string): Promise<Schedule> {
  const existing = await db.select().from(schedules).where(eq(schedules.projectId, projectId)).get()
  if (existing) return existing as unknown as Schedule

  const created: Schedule = {
    id: uuid(),
    projectId,
    agentId: null,
    enabled: false,
    intervalType: "fixed",
    runsPerDay: 1,
    featuresPerRun: 1,
    executionTimes: JSON.stringify([]),
    gitAutoPull: true,
    gitAutoCommit: true,
    gitAutoPush: false,
    gitAutoMerge: false,
    gitRunStartMode: "current",
    gitRunBranch: null,
    createdAt: now(),
    updatedAt: now(),
  }
  await db.insert(schedules).values(created as any).run()
  return created
}

