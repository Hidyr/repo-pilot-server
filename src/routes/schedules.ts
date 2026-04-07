import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { apiError } from "../http"
import { db, now } from "../db/client"
import { projects, schedules } from "../db/schema"
import { getScheduleForProject } from "../services/schedules.service"
import { registerSchedule } from "../services/scheduler.service"

export const schedulesRouter = new Hono()

schedulesRouter.get("/:projectId", async (c) => {
  const projectId = c.req.param("projectId")
  const schedule = await getScheduleForProject(projectId)
  return c.json({
    data: {
      enabled: schedule.enabled,
      intervalType: schedule.intervalType,
      runsPerDay: schedule.runsPerDay,
      featuresPerRun: schedule.featuresPerRun,
      executionTimes: JSON.parse(schedule.executionTimes ?? "[]"),
      gitAutoPull: schedule.gitAutoPull,
      gitAutoCommit: schedule.gitAutoCommit,
      gitAutoPush: schedule.gitAutoPush,
      gitAutoMerge: schedule.gitAutoMerge,
    },
  })
})

schedulesRouter.put("/:projectId", async (c) => {
  const projectId = c.req.param("projectId")
  const body = (await c.req.json()) as {
    enabled: boolean
    intervalType: "fixed" | "random"
    runsPerDay: number
    featuresPerRun: number
    executionTimes?: string[]
    gitAutoPull: boolean
    gitAutoCommit: boolean
    gitAutoPush: boolean
    gitAutoMerge: boolean
  }

  const proj = await db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!proj) return apiError(c, "PROJECT_NOT_FOUND", "Project not found", 404)
  const isGitRepo = Boolean((proj as any).isGitRepo)

  if (isGitRepo) {
    if (body.gitAutoMerge && !body.gitAutoPush) {
      return apiError(c, "MERGE_REQUIRES_PUSH", "Auto merge requires auto push", 400)
    }
    if (body.gitAutoPush && !body.gitAutoCommit) {
      return apiError(c, "PUSH_REQUIRES_COMMIT", "Auto push requires auto commit", 400)
    }
  }

  if (body.intervalType === "fixed") {
    const times = body.executionTimes ?? []
    if (!Array.isArray(times) || times.length !== body.runsPerDay) {
      return apiError(c, "VALIDATION_ERROR", "executionTimes length must equal runsPerDay", 400)
    }
  }

  const existing = await getScheduleForProject(projectId)

  await db
    .update(schedules)
    .set({
      enabled: Boolean(body.enabled),
      intervalType: body.intervalType,
      runsPerDay: body.runsPerDay,
      featuresPerRun: body.featuresPerRun,
      executionTimes: JSON.stringify(body.executionTimes ?? []),
      gitAutoPull: Boolean(body.gitAutoPull),
      gitAutoCommit: Boolean(body.gitAutoCommit),
      gitAutoPush: Boolean(body.gitAutoPush),
      gitAutoMerge: Boolean(body.gitAutoMerge),
      updatedAt: now(),
    } as any)
    .where(eq(schedules.id, existing.id))
    .run()

  const updated = await db.select().from(schedules).where(eq(schedules.id, existing.id)).get()
  if (updated) await registerSchedule(updated as any)

  return c.json({ data: updated })
})

