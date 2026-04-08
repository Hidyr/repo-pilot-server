import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { db, now, uuid } from "../db/client"
import { features, queueJobs, runs } from "../db/schema"
import { getMaxConcurrentRuns } from "./settings.service"
import { getScheduleForProject } from "./schedules.service"
import { executeFeatureRun } from "./runner.service"
import { queueSnapshot } from "./queueSnapshot.service"
import { broadcastBoard, broadcastQueue } from "../realtime"
import { boardSnapshot } from "./boardSnapshot.service"

// Active slots keyed by queue job id
const activeSlots = new Map<
  string,
  { jobId: string; promise: Promise<void>; controller: AbortController }
>()

function scheduleBroadcast() {
  // Fire-and-forget. Snapshot reads DB.
  queueSnapshot()
    .then((data) => {
      broadcastQueue(JSON.stringify({ type: "queue", data }))
    })
    .catch(() => {})
}

function scheduleBoardBroadcast(projectId: string) {
  boardSnapshot(projectId)
    .then((data) => {
      broadcastBoard(projectId, JSON.stringify({ type: "board", projectId, data }))
    })
    .catch(() => {})
}

export async function enqueueJob(
  projectId: string,
  featureId: string,
  priority = 0
): Promise<{ jobId: string; position: number }> {
  const existing = await db
    .select()
    .from(queueJobs)
    .where(
      and(eq(queueJobs.featureId, featureId), inArray(queueJobs.status, ["waiting", "active"]))
    )
    .all()
  if (existing.length > 0) throw new Error("ALREADY_QUEUED")

  const jobId = uuid()
  const createdAt = now()
  await db
    .insert(queueJobs)
    .values({
      id: jobId,
      projectId,
      featureId,
      status: "waiting",
      priority,
      createdAt,
    } as any)
    .run()

  const runId = uuid()
  await db
    .insert(runs)
    .values({
      id: runId,
      projectId,
      featureId,
      status: "queued",
      startedAt: createdAt,
    } as any)
    .run()

  await db.update(queueJobs).set({ runId }).where(eq(queueJobs.id, jobId)).run()

  await db.update(features).set({ status: "queued" }).where(eq(features.id, featureId)).run()

  // Synchronously attempt to claim a slot (does not await the run itself).
  await processQueue()

  const position = await getWaitingPosition(jobId)
  scheduleBroadcast()
  // enqueue writes feature status=queued; board should reflect immediately
  scheduleBoardBroadcast(projectId)
  return { jobId, position }
}

async function getWaitingPosition(jobId: string): Promise<number> {
  const waiting = await db
    .select({ id: queueJobs.id })
    .from(queueJobs)
    .where(eq(queueJobs.status, "waiting"))
    .orderBy(desc(queueJobs.priority), asc(queueJobs.createdAt))
    .all()
  const idx = waiting.findIndex((r) => r.id === jobId)
  return idx === -1 ? waiting.length : idx + 1
}

async function getNextWaitingJob() {
  return await db
    .select()
    .from(queueJobs)
    .where(eq(queueJobs.status, "waiting"))
    .orderBy(desc(queueJobs.priority), asc(queueJobs.createdAt))
    .limit(1)
    .get()
}

export async function processQueue(): Promise<void> {
  const maxSlots = await getMaxConcurrentRuns()

  while (activeSlots.size < maxSlots) {
    const next = await getNextWaitingJob()
    if (!next) break

    await db
      .update(queueJobs)
      .set({ status: "active", startedAt: now() })
      .where(eq(queueJobs.id, next.id))
      .run()

    // Immediately reflect "slot claimed" on the feature so clients can distinguish waiting vs running.
    await db
      .update(features)
      .set({ status: "in_progress", updatedAt: now() } as any)
      .where(eq(features.id, next.featureId))
      .run()
    scheduleBoardBroadcast(next.projectId)

    const schedule = await getScheduleForProject(next.projectId)

    const controller = new AbortController()
    const promise = executeFeatureRun(next as any, schedule as any, { signal: controller.signal })
      .catch(() => {})
      .finally(async () => {
        activeSlots.delete(next.id)
        // Only mark done if still active (cancellation marks it failed/skipped earlier).
        const cur = await db.select().from(queueJobs).where(eq(queueJobs.id, next.id)).get()
        if (cur?.status === "active") {
          await db
            .update(queueJobs)
            .set({ status: "done", completedAt: now() })
            .where(eq(queueJobs.id, next.id))
            .run()
        }
        scheduleBroadcast()
        scheduleBoardBroadcast(next.projectId)
        setTimeout(() => {
          processQueue().catch(() => {})
        }, 0)
      })

    activeSlots.set(next.id, { jobId: next.id, promise, controller })
    scheduleBroadcast()
  }
}

export async function cancelWaitingJob(jobId: string): Promise<void> {
  if (activeSlots.has(jobId)) throw new Error("JOB_ACTIVE")
  const job = await db.select().from(queueJobs).where(eq(queueJobs.id, jobId)).get()
  if (!job || job.status !== "waiting") throw new Error("JOB_NOT_FOUND_OR_NOT_WAITING")

  await db.update(features).set({ status: "pending" }).where(eq(features.id, job.featureId)).run()

  if (job.runId) {
    await db
      .update(runs)
      .set({ status: "skipped", completedAt: now(), errorMessage: "Cancelled by user" })
      .where(eq(runs.id, job.runId))
      .run()
  }

  await db.delete(queueJobs).where(eq(queueJobs.id, jobId)).run()
  scheduleBroadcast()
  scheduleBoardBroadcast(job.projectId)
}

export async function cancelActiveJob(jobId: string): Promise<void> {
  const slot = activeSlots.get(jobId)
  const job = await db.select().from(queueJobs).where(eq(queueJobs.id, jobId)).get()
  if (!job) throw new Error("JOB_NOT_FOUND")
  if (job.status !== "active") throw new Error("JOB_NOT_ACTIVE")
  if (!slot) throw new Error("JOB_NOT_TRACKED")

  // Abort agent work
  try {
    slot.controller.abort()
  } catch {
    /* ignore */
  }

  // Mark terminal state + free slot
  activeSlots.delete(jobId)

  await db
    .update(queueJobs)
    .set({ status: "failed", completedAt: now() })
    .where(eq(queueJobs.id, jobId))
    .run()

  // Revert feature + mark run skipped
  await db
    .update(features)
    .set({ status: "pending", updatedAt: now() } as any)
    .where(eq(features.id, job.featureId))
    .run()

  if (job.runId) {
    await db
      .update(runs)
      .set({ status: "skipped", completedAt: now(), errorMessage: "Cancelled by user" } as any)
      .where(eq(runs.id, job.runId))
      .run()
  }

  scheduleBroadcast()
  scheduleBoardBroadcast(job.projectId)

  // Immediately allow next job to start
  setTimeout(() => {
    processQueue().catch(() => {})
  }, 0)
}

/**
 * Stops queue work for a project (abort active jobs, cancel waiting) and deletes all queue_jobs rows.
 * Call this before deleting a project; queue_jobs are not declared with ON DELETE CASCADE.
 */
export async function purgeProjectQueueState(projectId: string): Promise<void> {
  const jobs = await db.select().from(queueJobs).where(eq(queueJobs.projectId, projectId)).all()
  const actives = jobs.filter((j) => j.status === "active")
  const waitings = jobs.filter((j) => j.status === "waiting")

  for (const j of actives) {
    try {
      await cancelActiveJob(j.id)
    } catch {
      const slot = activeSlots.get(j.id)
      if (slot) {
        try {
          slot.controller.abort()
        } catch {
          /* ignore */
        }
        activeSlots.delete(j.id)
      }
      await db.delete(queueJobs).where(eq(queueJobs.id, j.id)).run()
      setTimeout(() => {
        processQueue().catch(() => {})
      }, 0)
    }
  }

  for (const j of waitings) {
    try {
      await cancelWaitingJob(j.id)
    } catch {
      await db.delete(queueJobs).where(eq(queueJobs.id, j.id)).run()
    }
  }

  await db.delete(queueJobs).where(eq(queueJobs.projectId, projectId)).run()
  scheduleBroadcast()
}

/**
 * Remove only queued (waiting) jobs for a project.
 * Keeps any active (running) job going.
 */
export async function purgeWaitingJobsForProject(projectId: string): Promise<void> {
  const waitings = await db
    .select()
    .from(queueJobs)
    .where(and(eq(queueJobs.projectId, projectId), eq(queueJobs.status, "waiting")))
    .all()

  for (const job of waitings) {
    await db.update(features).set({ status: "pending" }).where(eq(features.id, job.featureId)).run()

    if ((job as any).runId) {
      await db
        .update(runs)
        .set({ status: "skipped", completedAt: now(), errorMessage: "Automation disabled" } as any)
        .where(eq(runs.id, (job as any).runId))
        .run()
    }

    await db.delete(queueJobs).where(eq(queueJobs.id, job.id)).run()
  }

  if (waitings.length > 0) {
    scheduleBroadcast()
    scheduleBoardBroadcast(projectId)
  }
}

/**
 * Remove all queue state for a single feature (abort if active), then delete its queue rows.
 */
export async function purgeFeatureQueueState(featureId: string, projectId: string): Promise<void> {
  const jobs = await db.select().from(queueJobs).where(eq(queueJobs.featureId, featureId)).all()
  const actives = jobs.filter((j) => j.status === "active")

  for (const j of actives) {
    try {
      await cancelActiveJob(j.id)
    } catch {
      const slot = activeSlots.get(j.id)
      if (slot) {
        try {
          slot.controller.abort()
        } catch {
          /* ignore */
        }
        activeSlots.delete(j.id)
      }
      await db.delete(queueJobs).where(eq(queueJobs.id, j.id)).run()
      setTimeout(() => {
        processQueue().catch(() => {})
      }, 0)
    }
  }

  await db.delete(queueJobs).where(eq(queueJobs.featureId, featureId)).run()
  scheduleBroadcast()
  scheduleBoardBroadcast(projectId)
  setTimeout(() => {
    processQueue().catch(() => {})
  }, 0)
}

export async function initializeQueue(): Promise<void> {
  // Mark orphaned active jobs failed
  await db
    .update(queueJobs)
    .set({ status: "failed", completedAt: now() })
    .where(eq(queueJobs.status, "active"))
    .run()

  // Revert features that were mid-run (queued or in_progress) back to pending
  await db
    .update(features)
    .set({ status: "pending" })
    .where(inArray(features.status, ["in_progress", "queued"]))
    .run()

  setTimeout(() => {
    processQueue().catch(() => {})
  }, 0)
  scheduleBroadcast()
}

