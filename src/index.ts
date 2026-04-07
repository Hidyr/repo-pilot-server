import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const DB_PATH = join(import.meta.dirname, "..", "db.json")
const PORT = Number(process.env.PORT ?? 3579)

type DB = {
  projects: Record<string, unknown>[]
  features: Record<string, unknown>[]
  runs: Record<string, unknown>[]
  agents: Record<string, unknown>[]
  settings: Record<string, string>
  queueJobs: QueueJobRow[]
  schedules: Record<string, Record<string, unknown>>
  schedulerPaused: boolean
}

type QueueJobRow = {
  id: string
  projectId: string
  projectName: string
  featureId: string
  featureTitle: string
  status: "waiting" | "active"
  priority: number
  createdAt: string
  startedAt?: string
}

function loadDb(): DB {
  const raw = readFileSync(DB_PATH, "utf-8")
  return JSON.parse(raw) as DB
}

function saveDb(db: DB) {
  writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, "utf-8")
}

function projectStats(db: DB, projectId: string) {
  const features = db.features.filter((f) => (f as { projectId?: string }).projectId === projectId)
  const pendingCount = features.filter((f) => {
    const s = String((f as { status?: unknown }).status ?? "")
    return s === "pending" || s === "failed"
  }).length
  const doneCount = features.filter(
    (f) => String((f as { status?: unknown }).status ?? "") === "done"
  ).length
  const hasActiveRun =
    features.some((f) => {
      const s = String((f as { status?: unknown }).status ?? "")
      return s === "queued" || s === "in_progress"
    }) || db.queueJobs.some((j) => j.projectId === projectId && j.status === "active")

  const runsForProject = (db.runs as Record<string, unknown>[]).filter(
    (r) => String(r.projectId ?? "") === projectId
  )
  const lastRunAt =
    runsForProject
      .map((r) => String(r.startedAt ?? ""))
      .filter(Boolean)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null

  return { pendingCount, doneCount, hasActiveRun, lastRunAt }
}

function projectWithStats(db: DB, p: Record<string, unknown>) {
  const id = String(p.id ?? "")
  if (!id) return p
  return { ...p, ...projectStats(db, id) }
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  })
}

function queuePayload(db: DB) {
  const max = Number(db.settings.max_concurrent_runs ?? 4)
  const active = db.queueJobs.filter((j) => j.status === "active")
  const waiting = db.queueJobs.filter((j) => j.status === "waiting")
  return {
    maxSlots: max,
    activeSlots: active.length,
    waitingCount: waiting.length,
    jobs: db.queueJobs,
  }
}

/** Changing max concurrent runs while work is active would not apply cleanly to in-flight runs. */
function hasActiveWork(db: DB): boolean {
  const queueBusy = db.queueJobs.some((j) => j.status === "active")
  const featureRunning = db.features.some(
    (f) => String((f as { status?: unknown }).status) === "in_progress"
  )
  return queueBusy || featureRunning
}

const queueSubscribers = new Set<Bun.ServerWebSocket<unknown>>()

function broadcastQueue(db: DB) {
  const msg = JSON.stringify({ type: "queue", data: queuePayload(db) })
  for (const ws of queueSubscribers) {
    try {
      ws.send(msg)
    } catch {
      queueSubscribers.delete(ws)
    }
  }
}

type BoardWsData = { projectId: string }
const boardSubscribersByProject = new Map<string, Set<Bun.ServerWebSocket<BoardWsData>>>()

function featuresPayloadForProject(db: DB, projectId: string) {
  return db.features
    .filter((f) => (f as { projectId: string }).projectId === projectId)
    .sort(
      (a, b) =>
        ((a as { sortOrder?: number }).sortOrder ?? 0) -
        ((b as { sortOrder?: number }).sortOrder ?? 0)
    )
}

function broadcastBoard(db: DB, projectId: string) {
  const subs = boardSubscribersByProject.get(projectId)
  if (!subs || subs.size === 0) return
  const msg = JSON.stringify({
    type: "board",
    projectId,
    data: { features: featuresPayloadForProject(db, projectId) },
  })
  for (const ws of subs) {
    try {
      ws.send(msg)
    } catch {
      subs.delete(ws)
    }
  }
  if (subs.size === 0) boardSubscribersByProject.delete(projectId)
}

/** Drop queue rows for a feature; call when it leaves in_progress / done / etc. */
function removeQueueJobsForFeature(db: DB, featureId: string) {
  db.queueJobs = db.queueJobs.filter((j) => j.featureId !== featureId)
}

function startRunForActiveJob(db: DB, job: QueueJobRow) {
  if (!job.featureId || job.featureId === "manual") return
  const existing = db.runs.some(
    (r) =>
      (r as { featureId?: string }).featureId === job.featureId &&
      (r as { status?: string }).status === "running"
  )
  if (existing) return
  db.runs.push({
    id: `run-${Date.now()}-${job.featureId}`,
    projectId: job.projectId,
    featureId: job.featureId,
    featureTitle: job.featureTitle,
    status: "running",
    startedAt: new Date().toISOString(),
    durationSec: 0,
    commit: null,
    pushed: false,
    merged: false,
    logLines: [
      "[AGENT] Session started",
      `[AGENT] Task: ${job.featureTitle}`,
      "[AGENT] Analyzing repository…",
    ],
  })
}

function finalizeRunForFeature(
  db: DB,
  featureId: string,
  outcome: "success" | "failed" | "skipped"
) {
  const idx = db.runs.findIndex(
    (r) =>
      (r as { featureId?: string }).featureId === featureId &&
      (r as { status?: string }).status === "running"
  )
  if (idx === -1) return
  const run = db.runs[idx] as Record<string, unknown>
  const start = new Date(String(run.startedAt)).getTime()
  run.status = outcome
  run.completedAt = new Date().toISOString()
  run.durationSec = Math.max(0, Math.round((Date.now() - start) / 1000))
  const lines = [...((run.logLines as string[] | undefined) ?? [])]
  if (outcome === "failed") {
    run.errorMessage = String(run.errorMessage ?? "Run failed")
    lines.push(`[ERROR] ${run.errorMessage}`)
  }
  if (outcome === "skipped") {
    lines.push("[AGENT] Run cancelled or stopped.")
  }
  if (outcome === "success") {
    lines.push("[AGENT] Completed successfully.")
  }
  run.logLines = lines
}

/** When a card moves to In progress, it joins the queue (active if slots free, else waiting). */
function enqueueFeatureJob(
  db: DB,
  featureId: string,
  row: Record<string, unknown>
): "active" | "waiting" {
  removeQueueJobsForFeature(db, featureId)
  const projectId = String(row.projectId ?? "")
  const proj = db.projects.find((p) => (p as { id: string }).id === projectId) as
    | { id: string; name: string }
    | undefined
  const projectName = proj?.name ?? "Project"
  const featureTitle = String(row.title ?? "")
  const maxSlots = Number(db.settings.max_concurrent_runs ?? 4)
  const activeCount = db.queueJobs.filter((j) => j.status === "active").length
  const slot: "active" | "waiting" = activeCount < maxSlots ? "active" : "waiting"
  const now = new Date().toISOString()
  const jobRow: QueueJobRow = {
    id: `job-${Date.now()}-${featureId}`,
    projectId,
    projectName,
    featureId,
    featureTitle,
    status: slot,
    priority: 1,
    createdAt: now,
    ...(slot === "active" ? { startedAt: now } : {}),
  }
  db.queueJobs.push(jobRow)
  if (slot === "active") startRunForActiveJob(db, jobRow)
  return slot
}

function inRunLaneStatus(status: string): boolean {
  return status === "in_progress" || status === "queued"
}

/** Promote `waiting` jobs to `active` until `max_concurrent_runs`; set features `queued` → `in_progress`. */
function processQueue(db: DB): string[] {
  const maxSlots = Number(db.settings.max_concurrent_runs ?? 4)
  const changedProjects = new Set<string>()
  while (true) {
    const activeCount = db.queueJobs.filter((j) => j.status === "active").length
    if (activeCount >= maxSlots) break
    const waiting = db.queueJobs
      .filter((j) => j.status === "waiting")
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      })
    if (waiting.length === 0) break
    const job = waiting[0]!
    job.status = "active"
    job.startedAt = new Date().toISOString()
    if (job.featureId && job.featureId !== "manual") {
      const fIdx = db.features.findIndex((f) => (f as { id: string }).id === job.featureId)
      if (fIdx !== -1) {
        const f = db.features[fIdx] as Record<string, unknown>
        db.features[fIdx] = { ...f, status: "in_progress" }
      }
    }
    startRunForActiveJob(db, job)
    changedProjects.add(job.projectId)
  }
  return [...changedProjects]
}

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url)
    const pathFull = url.pathname.replace(/\/$/, "") || "/"
    if (pathFull === "/api/queue/ws") {
      const ok = server.upgrade(req)
      if (ok) return undefined
      return new Response("WebSocket upgrade failed", { status: 400 })
    }
    const boardWsMatch = pathFull.match(/^\/api\/projects\/([^/]+)\/board\/ws$/)
    if (boardWsMatch) {
      const projectId = boardWsMatch[1]!
      const ok = server.upgrade(req, { data: { projectId } satisfies BoardWsData })
      if (ok) return undefined
      return new Response("WebSocket upgrade failed", { status: 400 })
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors } })
    }
    let path = url.pathname.replace(/\/$/, "") || "/"
    if (!path.startsWith("/api")) {
      return json({ error: "Not found" }, 404)
    }
    path = path.slice("/api".length) || "/"

    let db = loadDb()

    try {
      // ——— Projects ———
      if (req.method === "GET" && path === "/projects") {
        return json({
          data: (db.projects as Record<string, unknown>[]).map((p) => projectWithStats(db, p)),
        })
      }

      const projMatch = path.match(/^\/projects\/([^/]+)$/)
      if (projMatch && req.method === "GET") {
        const id = projMatch[1]
        const p = db.projects.find((x) => (x as { id: string }).id === id)
        if (!p) return json({ error: "NOT_FOUND" }, 404)
        return json({ data: projectWithStats(db, p as Record<string, unknown>) })
      }

      // ——— Features ———
      if (req.method === "GET" && path === "/features") {
        const projectId = url.searchParams.get("projectId")
        if (!projectId) return json({ error: "projectId required" }, 400)
        const list = db.features
          .filter((f) => (f as { projectId: string }).projectId === projectId)
          .sort(
            (a, b) =>
              ((a as { sortOrder?: number }).sortOrder ?? 0) -
              ((b as { sortOrder?: number }).sortOrder ?? 0)
          )
        return json({ data: list })
      }

      const featOneGet = path.match(/^\/features\/([^/]+)$/)
      if (featOneGet && req.method === "GET") {
        const fid = featOneGet[1]!
        const f = db.features.find((x) => (x as { id: string }).id === fid)
        if (!f) return json({ error: "NOT_FOUND" }, 404)
        return json({ data: f })
      }

      if (req.method === "POST" && path === "/features/reorder") {
        const body = (await req.json()) as {
          projectId?: string
          orderedIds?: string[]
        }
        if (!body.projectId || !Array.isArray(body.orderedIds)) {
          return json({ error: "INVALID_BODY" }, 400)
        }
        const idToOrder = new Map(body.orderedIds.map((id, i) => [id, i]))
        db.features = db.features.map((f) => {
          const row = f as { id: string; projectId: string; sortOrder?: number }
          if (row.projectId !== body.projectId) return f
          const o = idToOrder.get(row.id)
          if (o === undefined) return f
          return { ...(f as object), sortOrder: o } as Record<string, unknown>
        })
        saveDb(db)
        broadcastBoard(db, body.projectId)
        return json({ ok: true })
      }

      // PUT /features/:id (after /features/reorder so "reorder" is never treated as an id here)
      if (req.method === "PUT" && path.startsWith("/features/")) {
        const id = path.slice("/features/".length)
        if (!id || id.includes("/")) {
          return json({ error: "NOT_FOUND", path }, 404)
        }
        const body = (await req.json()) as Record<string, unknown>
        const idx = db.features.findIndex((f) => (f as { id: string }).id === id)
        if (idx === -1) {
          return json({ error: "FEATURE_NOT_FOUND", id }, 404)
        }
        const cur = db.features[idx] as Record<string, unknown>
        const projectId = String(cur.projectId ?? "")
        const prevStatus = String(cur.status ?? "")
        const next = {
          ...cur,
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.userPrompt !== undefined ? { userPrompt: body.userPrompt } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        }
        const newStatus = String(next.status ?? "")

        let queueTouched = false
        if (inRunLaneStatus(prevStatus) && !inRunLaneStatus(newStatus)) {
          removeQueueJobsForFeature(db, id)
          queueTouched = true
          if (newStatus === "done") finalizeRunForFeature(db, id, "success")
          else if (newStatus === "failed") finalizeRunForFeature(db, id, "failed")
          else finalizeRunForFeature(db, id, "skipped")
        }
        // Client uses "in_progress" for the In progress column; server maps to real state:
        // - job gets an active slot → feature stays `in_progress` (agent running)
        // - job is waiting → feature `queued` ("Waiting in queue", not agent running)
        if (newStatus === "in_progress" && prevStatus !== "in_progress") {
          const slot = enqueueFeatureJob(db, id, next)
          next.status = slot === "active" ? "in_progress" : "queued"
          queueTouched = true
        }

        db.features[idx] = next
        let promotedProjects: string[] = []
        if (queueTouched) {
          promotedProjects = processQueue(db)
        }
        saveDb(db)
        const boardsToPush = new Set<string>([projectId, ...promotedProjects].filter(Boolean))
        for (const p of boardsToPush) broadcastBoard(db, p)
        if (queueTouched) broadcastQueue(db)
        return json({ data: next })
      }

      // ——— Runs ———
      if (req.method === "GET" && path === "/runs") {
        const projectId = url.searchParams.get("projectId")
        const page = Math.max(1, Number(url.searchParams.get("page") ?? 1))
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)))
        let list = db.runs as Record<string, unknown>[]
        if (projectId) {
          list = list.filter((r) => r.projectId === projectId)
        }
        const featureIdFilter = url.searchParams.get("featureId")
        if (featureIdFilter) {
          list = list.filter((r) => (r as { featureId?: string }).featureId === featureIdFilter)
        }
        list = [...list].sort(
          (a, b) =>
            new Date(String(b.startedAt)).getTime() -
            new Date(String(a.startedAt)).getTime()
        )
        const total = list.length
        const start = (page - 1) * limit
        const data = list.slice(start, start + limit)
        return json({ data, total, page, limit })
      }

      // ——— Agents ———
      if (req.method === "GET" && path === "/agents") {
        return json({ data: db.agents })
      }

      const agentMatch = path.match(/^\/agents\/([^/]+)$/)
      if (agentMatch && req.method === "PUT") {
        const id = agentMatch[1]
        const body = (await req.json()) as Record<string, unknown>
        const idx = db.agents.findIndex((a) => (a as { id: string }).id === id)
        if (idx === -1) return json({ error: "NOT_FOUND" }, 404)
        const cur = db.agents[idx] as Record<string, unknown>
        const next = { ...cur, ...body }
        db.agents[idx] = next
        saveDb(db)
        return json({ data: next })
      }

      const agentTestMatch = path.match(/^\/agents\/([^/]+)\/test$/)
      if (agentTestMatch && req.method === "POST") {
        return json({
          success: true,
          version: "cursor-agent 1.2.3 (json-server demo)",
        })
      }

      // ——— Queue ———
      if (req.method === "GET" && path === "/queue") {
        return json({ data: queuePayload(db) })
      }

      const queueDel = path.match(/^\/queue\/([^/]+)$/)
      if (queueDel && req.method === "DELETE") {
        const jobId = queueDel[1]
        const job = db.queueJobs.find((j) => j.id === jobId)
        if (!job) return json({ error: "NOT_FOUND" }, 404)

        const fid = job.featureId
        const pid = job.projectId
        if (fid && fid !== "manual") {
          finalizeRunForFeature(db, fid, "skipped")
          const fIdx = db.features.findIndex((f) => (f as { id: string }).id === fid)
          if (fIdx !== -1) {
            const f = db.features[fIdx] as Record<string, unknown>
            db.features[fIdx] = { ...f, status: "pending" }
          }
        }

        db.queueJobs = db.queueJobs.filter((j) => j.id !== jobId)
        const promotedAfterDelete = processQueue(db)
        saveDb(db)
        const boardsAfterDelete = new Set<string>([pid, ...promotedAfterDelete].filter(Boolean))
        for (const p of boardsAfterDelete) broadcastBoard(db, p)
        broadcastQueue(db)
        return json({ ok: true })
      }

      // ——— Settings ———
      if (req.method === "GET" && path === "/settings") {
        const locked = hasActiveWork(db)
        return json({
          data: {
            ...db.settings,
            max_concurrent_runs_editable: locked ? "false" : "true",
            max_concurrent_runs_lock_reason: locked
              ? "Max concurrent runs cannot be changed while a feature is in progress or a queue job is active. Wait for active runs to finish."
              : "",
          },
        })
      }

      if (req.method === "PUT" && path === "/settings") {
        const body = (await req.json()) as Record<string, unknown>
        if (typeof body.max_concurrent_runs === "number") {
          const n = Math.min(4, Math.max(1, body.max_concurrent_runs))
          const cur = Number(db.settings.max_concurrent_runs ?? 4)
          if (n !== cur && hasActiveWork(db)) {
            return json(
              {
                error: "MAX_CONCURRENT_LOCKED",
                message:
                  "Cannot change max concurrent runs while a feature is in progress or a queue job is active.",
              },
              409
            )
          }
        }
        if (body.theme === "dark" || body.theme === "light") {
          db.settings.theme = body.theme
        }
        if (typeof body.autostart === "boolean") {
          db.settings.autostart = body.autostart ? "true" : "false"
        }
        if (typeof body.max_concurrent_runs === "number") {
          const n = Math.min(4, Math.max(1, body.max_concurrent_runs))
          db.settings.max_concurrent_runs = String(n)
        }
        if (typeof body.minimize_to_tray === "boolean") {
          db.settings.minimize_to_tray = body.minimize_to_tray ? "true" : "false"
        }
        let promotedFromMax = [] as string[]
        if (typeof body.max_concurrent_runs === "number") {
          promotedFromMax = processQueue(db)
        }
        saveDb(db)
        broadcastQueue(db)
        for (const p of promotedFromMax) broadcastBoard(db, p)
        return json({ data: db.settings })
      }

      // ——— Schedules ———
      const schedPath = path.match(/^\/schedules\/([^/]+)$/)
      if (schedPath && req.method === "GET") {
        const pid = schedPath[1]
        const row = db.schedules[pid]
        if (!row) {
          const def = {
            enabled: false,
            intervalType: "fixed",
            runsPerDay: 1,
            featuresPerRun: 1,
            executionTimes: [] as string[],
            gitAutoPull: false,
            gitAutoCommit: false,
            gitAutoPush: false,
            gitAutoMerge: false,
          }
          return json({ data: def })
        }
        return json({ data: row })
      }

      if (schedPath && req.method === "PUT") {
        const pid = schedPath[1]
        const body = (await req.json()) as Record<string, unknown>
        db.schedules[pid] = { ...db.schedules[pid], ...body } as Record<string, unknown>
        saveDb(db)
        return json({ data: db.schedules[pid] })
      }

      // ——— Scheduler control ———
      if (req.method === "POST" && path === "/scheduler/pause") {
        db.schedulerPaused = true
        saveDb(db)
        return json({ ok: true })
      }
      if (req.method === "POST" && path === "/scheduler/resume") {
        db.schedulerPaused = false
        saveDb(db)
        return json({ ok: true })
      }
      if (req.method === "GET" && path === "/scheduler/status") {
        return json({ paused: db.schedulerPaused })
      }

      // ——— Runs trigger ———
      if (req.method === "POST" && path === "/runs/trigger") {
        const body = (await req.json()) as { projectId?: string }
        if (!body.projectId) return json({ error: "projectId required" }, 400)
        const proj = db.projects.find(
          (p) => (p as { id: string }).id === body.projectId
        ) as { id: string; name: string } | undefined
        if (!proj) return json({ error: "NOT_FOUND" }, 404)
        const id = `job-${Date.now()}`
        db.queueJobs.push({
          id,
          projectId: body.projectId,
          projectName: proj.name,
          featureId: "manual",
          featureTitle: "Manual run",
          status: "waiting",
          priority: 1,
          createdAt: new Date().toISOString(),
        })
        const promotedTrigger = processQueue(db)
        saveDb(db)
        broadcastQueue(db)
        for (const p of promotedTrigger) broadcastBoard(db, p)
        const waiting = db.queueJobs.filter((j) => j.status === "waiting").length
        return json({ data: { jobId: id, position: waiting } })
      }

      return json({ error: "NOT_FOUND", path }, 404)
    } catch (e) {
      console.error(e)
      return json({ error: "INTERNAL", message: String(e) }, 500)
    }
  },
  websocket: {
    open(ws) {
      const data = ws.data as unknown
      if (data && typeof data === "object" && "projectId" in data) {
        const projectId = String((data as { projectId?: unknown }).projectId ?? "")
        if (!projectId) return
        let subs = boardSubscribersByProject.get(projectId)
        if (!subs) {
          subs = new Set()
          boardSubscribersByProject.set(projectId, subs)
        }
        subs.add(ws as Bun.ServerWebSocket<BoardWsData>)
        try {
          const db = loadDb()
          ws.send(
            JSON.stringify({
              type: "board",
              projectId,
              data: { features: featuresPayloadForProject(db, projectId) },
            })
          )
        } catch {
          /* ignore */
        }
        return
      }

      queueSubscribers.add(ws)
      try {
        const db = loadDb()
        ws.send(JSON.stringify({ type: "queue", data: queuePayload(db) }))
      } catch {
        /* ignore */
      }
    },
    close(ws) {
      queueSubscribers.delete(ws)
      const data = ws.data as unknown
      if (data && typeof data === "object" && "projectId" in data) {
        const projectId = String((data as { projectId?: unknown }).projectId ?? "")
        const subs = boardSubscribersByProject.get(projectId)
        subs?.delete(ws as Bun.ServerWebSocket<BoardWsData>)
        if (subs && subs.size === 0) boardSubscribersByProject.delete(projectId)
      }
    },
    message() {
      /* client messages ignored */
    },
  },
})

console.log(`repo-pilot json API on http://localhost:${PORT}/api`)
console.log(`queue WebSocket: ws://localhost:${PORT}/api/queue/ws`)

/** Demo-only: append synthetic agent lines to running runs (simulates streaming stdout). */
const DEMO_AGENT_LINES = [
  "[AGENT] Reading project files…",
  "[AGENT] Inspecting dependencies…",
  "[AGENT] Planning edits…",
  "[AGENT] Applying changes…",
  "[AGENT] Running quick validation…",
]
setInterval(() => {
  try {
    const db = loadDb()
    let touched = false
    for (const r of db.runs) {
      const row = r as { status?: string; logLines?: string[] }
      if (row.status !== "running") continue
      const lines = row.logLines ?? []
      if (lines.length > 48) continue
      const line = DEMO_AGENT_LINES[Math.floor(Math.random() * DEMO_AGENT_LINES.length)]!
      lines.push(line)
      row.logLines = lines
      touched = true
    }
    if (touched) saveDb(db)
  } catch {
    /* ignore */
  }
}, 3500)
