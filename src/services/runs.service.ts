import { eq } from "drizzle-orm"
import { db, now } from "../db/client"
import { runs } from "../db/schema"

export async function appendLog(runId: string, chunk: string): Promise<void> {
  const row = await db.select({ logs: runs.logs }).from(runs).where(eq(runs.id, runId)).get()
  const prev = row?.logs ?? ""
  const next = prev ? `${prev}${chunk.endsWith("\n") ? chunk : chunk + "\n"}` : chunk + "\n"
  await db.update(runs).set({ logs: next }).where(eq(runs.id, runId)).run()
}

export async function setRunStatus(
  runId: string,
  status: string,
  extra?: Partial<{
    completedAt: string
    errorMessage: string
    commitHash: string
    pushedAt: string
    mergedAt: string
  }>
): Promise<void> {
  await db
    .update(runs)
    .set({
      status,
      ...(extra ?? {}),
      ...(status === "running" ? {} : {}),
    } as any)
    .where(eq(runs.id, runId))
    .run()
}

export async function markRunCompleted(runId: string, status: "success" | "failed" | "skipped") {
  await db
    .update(runs)
    .set({ status, completedAt: now() } as any)
    .where(eq(runs.id, runId))
    .run()
}

