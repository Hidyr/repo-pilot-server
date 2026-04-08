import { db, now } from "../db/client"
import { agents, appSettings, features, projects, queueJobs, runs, schedules } from "../db/schema"
import { pauseAllSchedules, resumeAllSchedules } from "./scheduler.service"
import { queueSnapshot } from "./queueSnapshot.service"
import { broadcastQueue } from "../realtime"
import { seedDefaults } from "../db/client"

/**
 * Resets the application state to defaults:
 * - deletes projects/features/schedules/runs/queue jobs
 * - clears app_settings then re-seeds defaults
 * - resets built-in agents to "not tested" and disabled
 */
export async function resetDatabase(): Promise<void> {
  // Prevent cron from enqueueing during reset.
  pauseAllSchedules()

  // Best-effort: clear work tables (queue first, then dependent tables).
  await db.delete(queueJobs).run()
  await db.delete(runs).run()
  await db.delete(features).run()
  await db.delete(schedules).run()
  await db.delete(projects).run()

  // Reset app settings to defaults.
  await db.delete(appSettings).run()
  await seedDefaults()

  // Reset agent state.
  const t = now()
  await db
    .update(agents)
    .set({
      enabled: false,
      lastTestOk: false,
      lastTestedAt: null,
      lastTestOutput: null,
      updatedAt: t,
    } as any)
    .run()

  // Resume scheduler (it will have no enabled schedules).
  await resumeAllSchedules()

  // Broadcast empty queue snapshot.
  const q = await queueSnapshot()
  broadcastQueue(JSON.stringify({ type: "queue", data: q }))
}

