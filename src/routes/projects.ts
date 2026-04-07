import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { existsSync, realpathSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { basename, join } from "node:path"
import { apiError } from "../http"
import { db, now, uuid, sqlite } from "../db/client"
import { projects, schedules as schedulesTable } from "../db/schema"
import {
  detectGitInfo,
  gitCheckoutBranch,
  gitClone,
  gitListLocalBranches,
} from "../services/git.service"
import { getScheduleForProject } from "../services/schedules.service"
import { getSetting } from "../services/settings.service"
import { purgeProjectQueueState } from "../services/queue.service"
import { deregisterSchedule } from "../services/scheduler.service"
import { closeBoardSubscribers } from "../realtime"

export const projectsRouter = new Hono()

function normalizeLocalPath(p: string): string {
  const trimmed = p.trim().replace(/\/+$/, "")
  try {
    return realpathSync(trimmed)
  } catch {
    return trimmed
  }
}

function normalizeGitUrl(u: string): string {
  return u.trim().replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase()
}

function stats(projectId: string) {
  const pendingCount = (
    sqlite
      .prepare(
        "SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status IN ('pending','failed')"
      )
      .get(projectId) as { c: number }
  )?.c
  const doneCount = (
    sqlite
      .prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status = 'done'")
      .get(projectId) as { c: number }
  )?.c
  const hasActiveRun =
    ((sqlite
      .prepare(
        "SELECT 1 as x FROM features WHERE project_id = ? AND status IN ('queued','in_progress') LIMIT 1"
      )
      .get(projectId) as any)?.x ?? null) !== null ||
    ((sqlite
      .prepare(
        "SELECT 1 as x FROM queue_jobs WHERE project_id = ? AND status = 'active' LIMIT 1"
      )
      .get(projectId) as any)?.x ?? null) !== null

  const lastRun = sqlite
    .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(projectId) as any

  return {
    pendingCount: pendingCount ?? 0,
    doneCount: doneCount ?? 0,
    hasActiveRun,
    lastRun: lastRun ?? null,
  }
}

projectsRouter.get("/", async (c) => {
  const list = await db.select().from(projects).all()
  const enriched = list.map((p: any) => ({ ...p, ...stats(String(p.id)) }))
  return c.json({ data: enriched })
})

projectsRouter.post("/", async (c) => {
  const body = (await c.req.json()) as {
    type?: "local" | "git"
    localPath?: string
    gitUrl?: string
    clonePath?: string
    name?: string
  }

  if (body.type !== "local" && body.type !== "git") {
    return apiError(c, "VALIDATION_ERROR", "type must be 'local' or 'git'", 400)
  }

  // Enforce uniqueness (API-level; DB also has best-effort unique indexes).
  const existingProjects = await db.select().from(projects).all()

  let localPath: string
  let name: string
  if (body.type === "local") {
    if (!body.localPath) return apiError(c, "VALIDATION_ERROR", "localPath is required", 400)
    if (!existsSync(body.localPath)) {
      return apiError(c, "VALIDATION_ERROR", "localPath does not exist on disk", 400)
    }
    localPath = normalizeLocalPath(body.localPath)
    const already = existingProjects.some(
      (p: any) => normalizeLocalPath(String(p.localPath ?? "")) === localPath
    )
    if (already) {
      return apiError(c, "PROJECT_EXISTS", "A project with this local folder already exists.", 409)
    }
    name = body.name ?? basename(localPath)
  } else {
    if (!body.gitUrl) {
      return apiError(c, "VALIDATION_ERROR", "gitUrl is required", 400)
    }

    const incomingGit = normalizeGitUrl(body.gitUrl)
    const repoAlready = existingProjects.some((p: any) => {
      const ru = String(p.remoteUrl ?? "")
      if (!ru) return false
      return normalizeGitUrl(ru) === incomingGit
    })
    if (repoAlready) {
      return apiError(c, "REPO_EXISTS", "This Git repository was already added.", 409)
    }

    const repoName = basename(body.gitUrl.replace(/\/+$/, "").replace(/\.git$/, ""))
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const configuredBase = ((await getSetting("git_clone_base_dir")) ?? "").trim()
    const defaultBase = configuredBase || (home ? join(home, "projects") : "")
    const desired =
      body.clonePath && body.clonePath.trim()
        ? body.clonePath.trim()
        : defaultBase
          ? join(defaultBase, repoName)
          : ""

    if (!desired) {
      return apiError(
        c,
        "VALIDATION_ERROR",
        "clonePath is required (server could not determine a default folder)",
        400
      )
    }

    // If target already exists, add suffix to avoid clobbering.
    const ensureUniquePath = (p: string): string => {
      if (!existsSync(p)) return p
      for (let i = 2; i <= 50; i++) {
        const candidate = `${p}-${i}`
        if (!existsSync(candidate)) return candidate
      }
      return `${p}-${Date.now()}`
    }

    localPath = normalizeLocalPath(ensureUniquePath(desired))
    const localAlready = existingProjects.some(
      (p: any) => normalizeLocalPath(String(p.localPath ?? "")) === localPath
    )
    if (localAlready) {
      return apiError(c, "PROJECT_EXISTS", "A project with this local folder already exists.", 409)
    }
    name = body.name ?? repoName

    // Ensure parent directory exists (gitClone will create the leaf).
    await mkdir(dirname(localPath), { recursive: true }).catch(() => {})

    try {
      await gitClone(body.gitUrl, localPath)
    } catch (e) {
      return apiError(c, "CLONE_FAILED", (e as any)?.message ?? "git clone failed", 500)
    }
  }

  const gitInfo = await detectGitInfo(localPath)
  if (gitInfo.isGitRepo) {
    const detected = normalizeGitUrl(gitInfo.remoteUrl ?? "")
    if (detected) {
      const already = existingProjects.some((p: any) => {
        const ru = String(p.remoteUrl ?? "")
        if (!ru) return false
        return normalizeGitUrl(ru) === detected
      })
      if (already) {
        return apiError(c, "REPO_EXISTS", "This Git repository was already added.", 409)
      }
    }
  }
  const createdAt = now()
  const row: any = {
    id: uuid(),
    name,
    description: null,
    localPath,
    isGitRepo: gitInfo.isGitRepo,
    remoteUrl: gitInfo.isGitRepo ? gitInfo.remoteUrl ?? null : null,
    remoteName: gitInfo.isGitRepo ? gitInfo.remoteName ?? null : null,
    defaultBranch: gitInfo.isGitRepo ? gitInfo.defaultBranch ?? gitInfo.branch ?? null : null,
    createdAt,
    updatedAt: createdAt,
  }

  await db.insert(projects).values(row).run()

  // Ensure a default schedule exists (disabled)
  await getScheduleForProject(row.id)
  await db.update(schedulesTable).set({ enabled: false, updatedAt: now() } as any).where(eq(schedulesTable.projectId, row.id)).run()

  return c.json({ data: { ...row, ...stats(row.id) } })
})

projectsRouter.get("/:id", async (c) => {
  const id = c.req.param("id")
  const row = await db.select().from(projects).where(eq(projects.id, id)).get()
  if (!row) return apiError(c, "PROJECT_NOT_FOUND", "Project not found", 404)
  return c.json({ data: { ...(row as any), ...stats(id) } })
})

projectsRouter.get("/:id/git/branches", async (c) => {
  const id = c.req.param("id")
  const row = await db.select().from(projects).where(eq(projects.id, id)).get()
  if (!row) return apiError(c, "PROJECT_NOT_FOUND", "Project not found", 404)
  const localPath = String((row as any).localPath ?? "")
  if (!(row as any).isGitRepo) {
    return apiError(c, "NOT_GIT_REPO", "Project is not a Git repository", 400)
  }
  try {
    const { current, branches } = await gitListLocalBranches(localPath)
    return c.json({ data: { current, branches } })
  } catch (e) {
    return apiError(
      c,
      "GIT_ERROR",
      (e as Error)?.message ?? "Could not list branches",
      500
    )
  }
})

projectsRouter.post("/:id/git/checkout", async (c) => {
  const id = c.req.param("id")
  const body = (await c.req.json()) as { branch?: string }
  const branch = typeof body.branch === "string" ? body.branch : ""
  if (!branch.trim()) {
    return apiError(c, "VALIDATION_ERROR", "branch is required", 400)
  }
  const row = await db.select().from(projects).where(eq(projects.id, id)).get()
  if (!row) return apiError(c, "PROJECT_NOT_FOUND", "Project not found", 404)
  const localPath = String((row as any).localPath ?? "")
  if (!(row as any).isGitRepo) {
    return apiError(c, "NOT_GIT_REPO", "Project is not a Git repository", 400)
  }
  try {
    await gitCheckoutBranch(localPath, branch)
  } catch (e) {
    return apiError(
      c,
      "GIT_CHECKOUT_FAILED",
      (e as Error)?.message ?? "git checkout failed",
      400
    )
  }
  const gitInfo = await detectGitInfo(localPath)
  const branchLabel =
    gitInfo.branch && gitInfo.branch !== "HEAD"
      ? gitInfo.branch
      : gitInfo.defaultBranch ?? gitInfo.branch ?? null
  await db
    .update(projects)
    .set({
      defaultBranch: branchLabel,
      remoteUrl: gitInfo.isGitRepo ? gitInfo.remoteUrl ?? null : null,
      remoteName: gitInfo.isGitRepo ? gitInfo.remoteName ?? null : null,
      updatedAt: now(),
    } as any)
    .where(eq(projects.id, id))
    .run()
  const updated = await db.select().from(projects).where(eq(projects.id, id)).get()
  return c.json({ data: { ...(updated as any), ...stats(id) } })
})

projectsRouter.get("/:id/readme", async (c) => {
  const id = c.req.param("id")
  const row = await db.select().from(projects).where(eq(projects.id, id)).get()
  if (!row) return apiError(c, "PROJECT_NOT_FOUND", "Project not found", 404)

  const localPath = String((row as any).localPath ?? "")
  if (!localPath) return apiError(c, "VALIDATION_ERROR", "Project has no localPath", 400)

  const path = join(localPath, "README.md")
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      return c.json({ data: { exists: false, markdown: "" } })
    }
    const markdown = await file.text()
    return c.json({ data: { exists: true, markdown } })
  } catch (e) {
    return apiError(c, "INTERNAL", (e as any)?.message ?? "Could not read README.md", 500)
  }
})

projectsRouter.put("/:id", async (c) => {
  const id = c.req.param("id")
  const body = (await c.req.json()) as { name?: string; description?: string }
  const row = await db.select().from(projects).where(eq(projects.id, id)).get()
  if (!row) return apiError(c, "PROJECT_NOT_FOUND", "Project not found", 404)
  await db
    .update(projects)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      updatedAt: now(),
    } as any)
    .where(eq(projects.id, id))
    .run()
  const updated = await db.select().from(projects).where(eq(projects.id, id)).get()
  return c.json({ data: { ...(updated as any), ...stats(id) } })
})

projectsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const row = await db.select().from(projects).where(eq(projects.id, id)).get()
  if (!row) return apiError(c, "PROJECT_NOT_FOUND", "Project not found", 404)
  closeBoardSubscribers(id)
  await deregisterSchedule(id)
  await purgeProjectQueueState(id)
  await db.delete(projects).where(eq(projects.id, id)).run()
  return c.json({ ok: true })
})

