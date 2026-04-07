import { Hono } from "hono"
import { apiError } from "../http"
import { queueSnapshot } from "../services/queueSnapshot.service"
import { cancelActiveJob, cancelWaitingJob } from "../services/queue.service"
import { boardSnapshot } from "../services/boardSnapshot.service"
import { broadcastBoard, broadcastQueue } from "../realtime"
import { sqlite } from "../db/client"

export const queueRouter = new Hono()

queueRouter.get("/", async (c) => {
  const data = await queueSnapshot()
  return c.json({ data })
})

queueRouter.delete("/:jobId", async (c) => {
  const jobId = c.req.param("jobId")

  try {
    // Support cancelling waiting OR active jobs.
    const raw = sqlite
      .prepare(
        "SELECT feature_id as featureId, project_id as projectId, status as status FROM queue_jobs WHERE id = ?"
      )
      .get(jobId) as { featureId?: string; projectId?: string; status?: string } | undefined

    if (!raw?.featureId || !raw?.projectId) return apiError(c, "NOT_FOUND", "Queue job not found", 404)
    if (raw.status === "active") {
      await cancelActiveJob(jobId)
    } else {
      await cancelWaitingJob(jobId)
    }

    const board = await boardSnapshot(raw.projectId)
    broadcastBoard(
      raw.projectId,
      JSON.stringify({ type: "board", projectId: raw.projectId, data: board })
    )
    const queue = await queueSnapshot()
    broadcastQueue(JSON.stringify({ type: "queue", data: queue }))

    return c.json({ ok: true })
  } catch (e) {
    const msg = (e as any)?.message ?? String(e)
    return apiError(c, "INTERNAL", msg, 500)
  }
})

