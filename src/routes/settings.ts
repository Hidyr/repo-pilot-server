import { Hono } from "hono"
import { apiError } from "../http"
import { getSetting, hasActiveWork, setSetting } from "../services/settings.service"
import { queueSnapshot } from "../services/queueSnapshot.service"
import { broadcastQueue } from "../realtime"
import { resetDatabase } from "../services/reset.service"

export const settingsRouter = new Hono()

settingsRouter.get("/", async (c) => {
  const locked = await hasActiveWork()
  const theme = (await getSetting("theme")) ?? "dark"
  const autostart = (await getSetting("autostart")) ?? "true"
  const max_concurrent_runs = (await getSetting("max_concurrent_runs")) ?? "4"
  const minimize_to_tray = (await getSetting("minimize_to_tray")) ?? "true"
  const git_clone_base_dir = (await getSetting("git_clone_base_dir")) ?? ""

  return c.json({
    data: {
      theme,
      autostart,
      max_concurrent_runs,
      minimize_to_tray,
      git_clone_base_dir,
      max_concurrent_runs_editable: locked ? "false" : "true",
      max_concurrent_runs_lock_reason: locked
        ? "Max concurrent runs cannot be changed while a feature is in progress or a queue job is active. Wait for active runs to finish."
        : "",
    },
  })
})

settingsRouter.put("/", async (c) => {
  const body = (await c.req.json()) as {
    theme?: "dark" | "light"
    autostart?: boolean
    max_concurrent_runs?: number
    minimize_to_tray?: boolean
    git_clone_base_dir?: string
  }

  const wantsMax =
    typeof body.max_concurrent_runs === "number" && Number.isFinite(body.max_concurrent_runs)
  if (wantsMax) {
    const locked = await hasActiveWork()
    const current = Number.parseInt((await getSetting("max_concurrent_runs")) ?? "4", 10) || 4
    const next = Math.min(4, Math.max(1, Math.trunc(body.max_concurrent_runs!)))
    if (next !== current && locked) {
      return apiError(
        c,
        "MAX_CONCURRENT_LOCKED",
        "Cannot change max concurrent runs while a feature is in progress or a queue job is active.",
        409
      )
    }
  }

  if (body.theme === "dark" || body.theme === "light") await setSetting("theme", body.theme)
  if (typeof body.autostart === "boolean") await setSetting("autostart", body.autostart ? "true" : "false")
  if (typeof body.minimize_to_tray === "boolean")
    await setSetting("minimize_to_tray", body.minimize_to_tray ? "true" : "false")
  if (typeof body.git_clone_base_dir === "string") {
    // allow blank (means "use default ~/projects")
    const v = body.git_clone_base_dir.trim()
    await setSetting("git_clone_base_dir", v)
  }
  if (wantsMax) {
    const next = Math.min(4, Math.max(1, Math.trunc(body.max_concurrent_runs!)))
    await setSetting("max_concurrent_runs", String(next))
  }

  const data = {
    theme: (await getSetting("theme")) ?? "dark",
    autostart: (await getSetting("autostart")) ?? "true",
    max_concurrent_runs: (await getSetting("max_concurrent_runs")) ?? "4",
    minimize_to_tray: (await getSetting("minimize_to_tray")) ?? "true",
    git_clone_base_dir: (await getSetting("git_clone_base_dir")) ?? "",
  }

  if (wantsMax) {
    const q = await queueSnapshot()
    broadcastQueue(JSON.stringify({ type: "queue", data: q }))
  }

  return c.json({ data })
})

settingsRouter.post("/reset", async (c) => {
  const locked = await hasActiveWork()
  if (locked) {
    return apiError(
      c,
      "RESET_LOCKED",
      "Cannot reset database while work is active. Cancel active queue jobs first.",
      409
    )
  }
  await resetDatabase()
  return c.json({ ok: true })
})

