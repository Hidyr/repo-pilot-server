import { Hono } from "hono"
import { cors } from "hono/cors"
import { runMigrations, seedDefaults } from "./db/client"
import { initializeQueue } from "./services/queue.service"
import { initializeScheduler } from "./services/scheduler.service"
import { projectsRouter } from "./routes/projects"
import { featuresRouter } from "./routes/features"
import { schedulesRouter } from "./routes/schedules"
import { agentsRouter } from "./routes/agents"
import { runsRouter } from "./routes/runs"
import { queueRouter } from "./routes/queue"
import { settingsRouter } from "./routes/settings"
import { schedulerRouter } from "./routes/scheduler"
import {
  addBoardSubscriber,
  addQueueSubscriber,
  removeBoardSubscriber,
  removeQueueSubscriber,
} from "./realtime"
import { queueSnapshot } from "./services/queueSnapshot.service"
import { boardSnapshot } from "./services/boardSnapshot.service"

const PORT = Number(process.env.PORT ?? 3579)

const app = new Hono()

app.use(
  "*",
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "tauri://localhost",
      "http://localhost:1420",
      "http://127.0.0.1:1420",
    ],
  })
)

app.route("/api/projects", projectsRouter)
app.route("/api/features", featuresRouter)
app.route("/api/schedules", schedulesRouter)
app.route("/api/agents", agentsRouter)
app.route("/api/runs", runsRouter)
app.route("/api/queue", queueRouter)
app.route("/api/settings", settingsRouter)
app.route("/api/scheduler", schedulerRouter)

app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }))

async function start() {
  await runMigrations()
  await seedDefaults()
  await initializeQueue()
  await initializeScheduler()

  Bun.serve({
    port: PORT,
    fetch(req, server) {
      const url = new URL(req.url)
      const path = url.pathname.replace(/\/$/, "")

      if (path === "/api/queue/ws") {
        const ok = server.upgrade(req)
        if (ok) return undefined
        return new Response("WebSocket upgrade failed", { status: 400 })
      }

      const boardWsMatch = path.match(/^\/api\/projects\/([^/]+)\/board\/ws$/)
      if (boardWsMatch) {
        const projectId = boardWsMatch[1]!
        const ok = server.upgrade(req, { data: { projectId } })
        if (ok) return undefined
        return new Response("WebSocket upgrade failed", { status: 400 })
      }

      return app.fetch(req)
    },
    websocket: {
      async open(ws) {
        const data = ws.data as unknown
        if (data && typeof data === "object" && "projectId" in data) {
          const projectId = String((data as any).projectId ?? "")
          if (!projectId) return
          addBoardSubscriber(projectId, ws as any)
          const payload = await boardSnapshot(projectId)
          ws.send(JSON.stringify({ type: "board", projectId, data: payload }))
          return
        }

        addQueueSubscriber(ws as any)
        const payload = await queueSnapshot()
        ws.send(JSON.stringify({ type: "queue", data: payload }))
      },
      close(ws) {
        const data = ws.data as unknown
        if (data && typeof data === "object" && "projectId" in data) {
          const projectId = String((data as any).projectId ?? "")
          if (projectId) removeBoardSubscriber(projectId, ws as any)
          return
        }
        removeQueueSubscriber(ws as any)
      },
      message() {
        /* client messages ignored */
      },
    },
  })

  console.log(`RepoPilot backend running on http://localhost:${PORT}`)
  console.log(`Queue WebSocket: ws://localhost:${PORT}/api/queue/ws`)
}

start().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
