import { Hono } from "hono"
import { pauseAllSchedules, resumeAllSchedules, schedulerStatus } from "../services/scheduler.service"

export const schedulerRouter = new Hono()

schedulerRouter.post("/pause", (c) => {
  pauseAllSchedules()
  return c.json({ ok: true })
})

schedulerRouter.post("/resume", async (c) => {
  await resumeAllSchedules()
  return c.json({ ok: true })
})

schedulerRouter.get("/status", (c) => {
  return c.json(schedulerStatus())
})

