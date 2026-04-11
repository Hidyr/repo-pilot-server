import { Hono } from "hono"
import { and, desc, eq } from "drizzle-orm"
import { apiError } from "../http"
import { db, now, uuid } from "../db/client"
import { runs } from "../db/schema"
import { selectNextFeature } from "../services/featureSelection.service"
import { enqueueJob } from "../services/queue.service"
import { queueSnapshot } from "../services/queueSnapshot.service"
import { broadcastQueue } from "../realtime"

export const runsRouter = new Hono()

runsRouter.get("/", async (c) => {
  const projectId = c.req.query("projectId")
  const featureId = c.req.query("featureId")
  const page = Math.max(1, Number(c.req.query("page") ?? 1))
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)))

  let where = undefined as any
  if (projectId && featureId) {
    where = and(eq(runs.projectId, projectId), eq(runs.featureId, featureId))
  } else if (projectId) {
    where = eq(runs.projectId, projectId)
  } else if (featureId) {
    where = eq(runs.featureId, featureId)
  }

  const allRows = where
    ? await db.select().from(runs).where(where).orderBy(desc(runs.startedAt)).all()
    : await db.select().from(runs).orderBy(desc(runs.startedAt)).all()

  const total = allRows.length
  const start = (page - 1) * limit
  const data = allRows.slice(start, start + limit)
  return c.json({ data, total, page, limit })
})

runsRouter.get("/:id", async (c) => {
  const id = c.req.param("id")
  const row = await db.select().from(runs).where(eq(runs.id, id)).get()
  if (!row) return apiError(c, "NOT_FOUND", "Run not found", 404)
  return c.json({ data: row })
})

runsRouter.post("/trigger", async (c) => {
  const body = (await c.req.json()) as { projectId?: string }
  if (!body.projectId) return apiError(c, "VALIDATION_ERROR", "projectId is required", 400)

  const feature = await selectNextFeature(body.projectId)
  if (!feature) {
    // Create a skipped run record so history shows the attempt.
    await db
      .insert(runs)
      .values({
        id: uuid(),
        projectId: body.projectId,
        featureId: null,
        status: "skipped",
        errorMessage: "No pending features",
        startedAt: now(),
        completedAt: now(),
      } as any)
      .run()
    return c.json({ error: { code: "NO_FEATURES", message: "No pending features available" } }, 200)
  }

  try {
    const { jobId, position } = await enqueueJob(body.projectId, feature.id, 1)
    const q = await queueSnapshot()
    broadcastQueue(JSON.stringify({ type: "queue", data: q }))
    return c.json({ data: { jobId, position } })
  } catch (e) {
    const msg = (e as any)?.message ?? String(e)
    if (msg === "ALREADY_QUEUED") return apiError(c, "ALREADY_QUEUED", "Feature already queued", 409)
    if (msg === "NO_RUNNABLE_AGENT") {
      return apiError(
        c,
        "NO_RUNNABLE_AGENT",
        "Enable and successfully test an agent before running automation or queue jobs.",
        400
      )
    }
    if (msg === "FEATURE_FROZEN") {
      return apiError(c, "FEATURE_FROZEN", "That feature is frozen. Unfreeze it on the feature page to queue it.", 409)
    }
    return apiError(c, "INTERNAL", msg, 500)
  }
})

