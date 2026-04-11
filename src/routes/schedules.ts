import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { apiError } from "../http"
import { db, now } from "../db/client"
import { agents, projects, schedules } from "../db/schema"
import { resolveAgentForSchedule } from "../services/agent.service"
import { getScheduleForProject } from "../services/schedules.service"
import { registerSchedule } from "../services/scheduler.service"
import { purgeWaitingJobsForProject } from "../services/queue.service"
import { assertSafeGitRef } from "../services/git.service"
import type { GitRunStartMode } from "../types"

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
      gitRunStartMode: (schedule as { gitRunStartMode?: string }).gitRunStartMode ?? "current",
      gitRunBranch: (schedule as { gitRunBranch?: string | null }).gitRunBranch ?? null,
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
    gitRunStartMode?: GitRunStartMode
    gitRunBranch?: string | null
  }

  const proj = await db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!proj) return apiError(c, "PROJECT_NOT_FOUND", "Project not found", 404)
  const isGitRepo = Boolean((proj as any).isGitRepo)

  const rawMode = body.gitRunStartMode
  const gitRunStartMode: GitRunStartMode =
    rawMode === "from_base" || rawMode === "branch" || rawMode === "current" ? rawMode : "current"

  let gitRunBranch: string | null = null
  if (isGitRepo && gitRunStartMode === "branch") {
    const t = typeof body.gitRunBranch === "string" ? body.gitRunBranch.trim() : ""
    if (!t) {
      return apiError(c, "GIT_RUN_BRANCH_REQUIRED", "Branch name is required when starting from a fixed branch", 400)
    }
    try {
      gitRunBranch = assertSafeGitRef(t)
    } catch {
      return apiError(c, "INVALID_BRANCH", "Invalid branch name", 400)
    }
  }

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
      gitRunStartMode,
      gitRunBranch,
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

