import { and, asc, eq, notInArray } from "drizzle-orm"
import { db } from "../db/client"
import { features } from "../db/schema"
import type { Feature } from "../types"

export async function selectNextFeature(
  projectId: string,
  opts?: { excludeIds?: string[] }
): Promise<Feature | null> {
  const exclude = (opts?.excludeIds ?? []).filter(Boolean)

  const pending = await db
    .select()
    .from(features)
    .where(
      and(
        eq(features.projectId, projectId),
        eq(features.status, "pending"),
        ...(exclude.length ? [notInArray(features.id, exclude)] : [])
      )
    )
    .orderBy(asc(features.sortOrder))
    .limit(1)
    .all()
  return (pending[0] as any) ?? null
}

