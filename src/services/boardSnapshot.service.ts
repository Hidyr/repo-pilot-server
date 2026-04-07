import { and, asc, eq } from "drizzle-orm"
import { db } from "../db/client"
import { features } from "../db/schema"

export async function boardSnapshot(projectId: string) {
  const list = await db
    .select()
    .from(features)
    .where(eq(features.projectId, projectId))
    .orderBy(asc(features.sortOrder))
    .all()
  return { features: list }
}

