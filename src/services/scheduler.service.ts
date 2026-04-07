import { CronJob } from "cron"
import { eq } from "drizzle-orm"
import { db } from "../db/client"
import { schedules } from "../db/schema"
import type { Schedule } from "../types"
import { enqueueJob } from "./queue.service"
import { selectNextFeature } from "./featureSelection.service"

const activeJobs = new Map<string, CronJob[]>()
let schedulerPaused = false

export async function getAllEnabledSchedules(): Promise<Schedule[]> {
  return (await db.select().from(schedules).where(eq(schedules.enabled, true)).all()) as any
}

export async function initializeScheduler(): Promise<void> {
  const all = await getAllEnabledSchedules()
  for (const s of all) await registerSchedule(s)
}

export async function deregisterSchedule(projectId: string): Promise<void> {
  ;(activeJobs.get(projectId) ?? []).forEach((j) => j.stop())
  activeJobs.delete(projectId)
}

export async function registerSchedule(schedule: Schedule): Promise<void> {
  await deregisterSchedule(schedule.projectId)
  if (schedulerPaused) return
  if (!schedule.enabled) return

  const jobs: CronJob[] = []
  const cronExprs =
    schedule.intervalType === "fixed"
      ? buildFixedCrons(schedule)
      : generateRandomCrons(schedule.runsPerDay)

  for (const cronExpr of cronExprs) {
    const job = new CronJob(cronExpr, () => {
      scheduleProjectRun(schedule.projectId, schedule.featuresPerRun).catch(() => {})
    })
    job.start()
    jobs.push(job)
  }

  activeJobs.set(schedule.projectId, jobs)
}

export function pauseAllSchedules(): void {
  schedulerPaused = true
  activeJobs.forEach((jobs) => jobs.forEach((j) => j.stop()))
}

export async function resumeAllSchedules(): Promise<void> {
  schedulerPaused = false
  const all = await getAllEnabledSchedules()
  for (const s of all) await registerSchedule(s)
}

export function schedulerStatus(): { paused: boolean } {
  return { paused: schedulerPaused }
}

function buildFixedCrons(schedule: Schedule): string[] {
  const times = (JSON.parse(schedule.executionTimes ?? "[]") as string[]) ?? []
  return times
    .map((time) => {
      const [hour, minute] = time.split(":")
      if (hour === undefined || minute === undefined) return null
      return `${minute} ${hour} * * *`
    })
    .filter((x): x is string => Boolean(x))
}

function generateRandomCrons(count: number): string[] {
  const set = new Set<string>()
  while (set.size < Math.max(0, count)) {
    const hour = Math.floor(Math.random() * 14) + 7 // 7am–9pm
    const minute = Math.floor(Math.random() * 60)
    set.add(`${minute} ${hour} * * *`)
  }
  return Array.from(set)
}

async function scheduleProjectRun(projectId: string, featuresPerRun: number): Promise<void> {
  for (let i = 0; i < featuresPerRun; i++) {
    const feature = await selectNextFeature(projectId)
    if (!feature) break
    try {
      await enqueueJob(projectId, feature.id, 0)
    } catch (err) {
      if ((err as any)?.message === "ALREADY_QUEUED") continue
    }
  }
}

