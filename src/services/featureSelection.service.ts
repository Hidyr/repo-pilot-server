import { and, asc, eq, inArray } from "drizzle-orm"
import { db } from "../db/client"
import { features } from "../db/schema"
import type { Feature } from "../types"

export async function selectNextFeature(projectId: string): Promise<Feature | null> {
  const activeStatuses = ["queued", "in_progress"] as const
  const alreadyActive = await db
    .select()
    .from(features)
    .where(and(eq(features.projectId, projectId), inArray(features.status, activeStatuses as any)))
    .limit(1)
    .all()
  if (alreadyActive.length > 0) return null

  const pending = await db
    .select()
    .from(features)
    .where(and(eq(features.projectId, projectId), eq(features.status, "pending")))
    .orderBy(asc(features.sortOrder))
    .limit(1)
    .all()
  return (pending[0] as any) ?? null
}

