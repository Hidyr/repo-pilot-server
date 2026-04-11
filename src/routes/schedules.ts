import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { apiError } from "../http"
import { db, now } from "../db/client"
import { agents, projects, schedules } from "../db/schema"
import { resolveAgentForSchedule } from "../services/agent.service"
import { getScheduleForProject } from "../services/schedules.service"
import { registerSchedule } from "../services/scheduler.service"
import { purgeWaitingJobsForProject } from "../services/queue.service"

export const schedulesRouter = new Hono()

schedulesRouter.get("/:projectId", async (c) => {
  const projectId = c.req.param("projectId")
  const schedule = await getScheduleForProject(projectId)
  return c.json({
    data: {
      agentId: schedule.agentId ?? null,
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
    agentId?: string | null
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
  const wasEnabled = Boolean((existing as any).enabled)

  let agentId: string | null = null
  if (body.agentId !== undefined) {
    if (body.agentId === null || body.agentId === "") {
      agentId = null
    } else {
      const id = String(body.agentId)
      const a = await db.select().from(agents).where(eq(agents.id, id)).get()
      if (!a) return apiError(c, "AGENT_NOT_FOUND", "Selected agent not found", 400)
      if (!(a as any).lastTestOk) {
        return apiError(c, "AGENT_NOT_TESTED", "Selected agent must be tested before use", 400)
      }
      agentId = id
    }
  } else {
    agentId = (existing as any).agentId ?? null
  }

  const requestedEnabled = Boolean(body.enabled)
  const enabledEffective =
    requestedEnabled && !!(await resolveAgentForSchedule({ agentId }))

  await db
    .update(schedules)
    .set({
      agentId,
      enabled: enabledEffective,
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

  if (wasEnabled && !enabledEffective) {
    await purgeWaitingJobsForProject(projectId)
  }

  return c.json({
    data: updated,
    ...(requestedEnabled && !enabledEffective
      ? {
          meta: {
            warning:
              "Automation was saved as off: enable and successfully test an agent (or pick a tested agent for this project) before automation can run.",
          },
        }
      : {}),
  })
})

