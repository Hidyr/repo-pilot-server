import { Hono } from "hono"
import { and, asc, eq, inArray } from "drizzle-orm"
import { apiError } from "../http"
import { db, now, uuid } from "../db/client"
import { features, queueJobs, runs } from "../db/schema"
import { enqueueJob, processQueue, purgeFeatureQueueState } from "../services/queue.service"
import { boardSnapshot } from "../services/boardSnapshot.service"
import { queueSnapshot } from "../services/queueSnapshot.service"
import { broadcastBoard, broadcastQueue } from "../realtime"
import { sqlite } from "../db/client"

export const featuresRouter = new Hono()

featuresRouter.get("/", async (c) => {
  const projectId = c.req.query("projectId")
  if (!projectId) return apiError(c, "VALIDATION_ERROR", "projectId is required", 400)
  const list = await db
    .select()
    .from(features)
    .where(eq(features.projectId, projectId))
    .orderBy(asc(features.sortOrder))
    .all()
  return c.json({ data: list })
})

featuresRouter.post("/", async (c) => {
  const body = (await c.req.json()) as {
    projectId?: string
    title?: string
    description?: string
    userPrompt?: string
  }
  if (!body.projectId || !body.title) {
    return apiError(c, "VALIDATION_ERROR", "projectId and title are required", 400)
  }
  const max = sqlite
    .prepare("SELECT COALESCE(MAX(sort_order), -1) as m FROM features WHERE project_id = ?")
    .get(body.projectId) as { m: number }
  const sortOrder = Number(max?.m ?? -1) + 1
  const row = {
    id: uuid(),
    projectId: body.projectId,
    title: body.title,
    description: body.description ?? null,
    userPrompt: typeof body.userPrompt === "string" ? body.userPrompt : null,
    status: "pending",
    sortOrder,
    createdAt: now(),
    updatedAt: now(),
  }
  await db.insert(features).values(row as any).run()
  const board = await boardSnapshot(body.projectId)
  broadcastBoard(body.projectId, JSON.stringify({ type: "board", projectId: body.projectId, data: board }))
  return c.json({ data: row })
})

featuresRouter.post("/reorder", async (c) => {
  const body = (await c.req.json()) as { projectId?: string; orderedIds?: string[] }
  if (!body.projectId || !Array.isArray(body.orderedIds)) {
    return apiError(c, "VALIDATION_ERROR", "projectId and orderedIds are required", 400)
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < body.orderedIds!.length; i++) {
      const id = body.orderedIds![i]!
      await tx
        .update(features)
        .set({ sortOrder: i, updatedAt: now() } as any)
        .where(and(eq(features.id, id), eq(features.projectId, body.projectId!)))
        .run()
    }
  })

  const board = await boardSnapshot(body.projectId)
  broadcastBoard(body.projectId, JSON.stringify({ type: "board", projectId: body.projectId, data: board }))
  return c.json({ ok: true })
})

featuresRouter.get("/:id", async (c) => {
  const id = c.req.param("id")
  const row = await db.select().from(features).where(eq(features.id, id)).get()
  if (!row) return apiError(c, "FEATURE_NOT_FOUND", "Feature not found", 404)
  return c.json({ data: row })
})

featuresRouter.put("/:id", async (c) => {
  const id = c.req.param("id")
  const body = (await c.req.json()) as Record<string, unknown>
  const cur = await db.select().from(features).where(eq(features.id, id)).get()
  if (!cur) return apiError(c, "FEATURE_NOT_FOUND", "Feature not found", 404)

  const prevStatus = String((cur as any).status ?? "")
  let nextStatus = body.status !== undefined ? String(body.status) : prevStatus

  let queueTouched = false
  const leavingRunLane = inArrayLiteral(prevStatus, ["queued", "in_progress"]) && !inArrayLiteral(nextStatus, ["queued", "in_progress"])

  if (leavingRunLane) {
    // If the job is active, we don't support mid-run cancel via this path.
    const active = await db
      .select()
      .from(queueJobs)
      .where(and(eq(queueJobs.featureId, id), eq(queueJobs.status, "active")))
      .limit(1)
      .all()
    if (active.length > 0) return apiError(c, "JOB_ACTIVE", "Feature is actively running", 409)

    await db.delete(queueJobs).where(eq(queueJobs.featureId, id)).run()
    queueTouched = true

    // Finalize the most recent run record for this feature (queued or running).
    const running = sqlite
      .prepare(
        "SELECT id, status, error_message as errorMessage FROM runs WHERE feature_id = ? AND status IN ('queued','running') ORDER BY started_at DESC LIMIT 1"
      )
      .get(id) as { id: string; status: string; errorMessage: string | null } | undefined

    if (running?.id) {
      const outcome =
        nextStatus === "done" ? "success" : nextStatus === "failed" ? "failed" : "skipped"
      const errorMessage =
        outcome === "failed"
          ? String((body.errorMessage as any) ?? running.errorMessage ?? "Run failed")
          : outcome === "skipped"
            ? String(running.errorMessage ?? "Cancelled by user")
            : null

      await db
        .update(runs)
        .set({ status: outcome, completedAt: now(), ...(errorMessage ? { errorMessage } : {}) } as any)
        .where(eq(runs.id, running.id))
        .run()
    }
  }

  // Entering the run lane: client usually sends status=in_progress.
  if (nextStatus === "in_progress" && prevStatus !== "in_progress") {
    try {
      await enqueueJob(String((cur as any).projectId), id, 1)
      queueTouched = true
      // Normalize: if job is active => in_progress else queued
      const job = await db
        .select()
        .from(queueJobs)
        .where(and(eq(queueJobs.featureId, id), inArray(queueJobs.status, ["waiting", "active"])))
        .limit(1)
        .get()
      nextStatus = job?.status === "active" ? "in_progress" : "queued"
    } catch (e) {
      const msg = (e as any)?.message ?? String(e)
      if (msg === "ALREADY_QUEUED") return apiError(c, "ALREADY_QUEUED", "Feature already queued", 409)
      return apiError(c, "INTERNAL", msg, 500)
    }
  }

  const update: Record<string, unknown> = { updatedAt: now() }
  if (body.title !== undefined) update.title = body.title
  if (body.description !== undefined) update.description = body.description
  if (body.userPrompt !== undefined) update.userPrompt = body.userPrompt
  if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder
  if (body.status !== undefined) update.status = nextStatus

  await db.update(features).set(update as any).where(eq(features.id, id)).run()

  if (queueTouched) await processQueue()

  const updated = await db.select().from(features).where(eq(features.id, id)).get()
  const projectId = String((updated as any)?.projectId ?? (cur as any).projectId)

  const board = await boardSnapshot(projectId)
  broadcastBoard(projectId, JSON.stringify({ type: "board", projectId, data: board }))
  if (queueTouched) {
    const q = await queueSnapshot()
    broadcastQueue(JSON.stringify({ type: "queue", data: q }))
  }

  return c.json({ data: updated })
})

featuresRouter.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const row = await db.select().from(features).where(eq(features.id, id)).get()
  if (!row) return apiError(c, "FEATURE_NOT_FOUND", "Feature not found", 404)

  const projectId = String((row as any).projectId)
  await purgeFeatureQueueState(id, projectId)
  await db.delete(runs).where(eq(runs.featureId, id)).run()
  await db.delete(features).where(eq(features.id, id)).run()

  const board = await boardSnapshot(projectId)
  broadcastBoard(projectId, JSON.stringify({ type: "board", projectId, data: board }))
  const q = await queueSnapshot()
  broadcastQueue(JSON.stringify({ type: "queue", data: q }))

  return c.json({ ok: true })
})

function inArrayLiteral(value: string, set: readonly string[]): boolean {
  return set.includes(value)
}

