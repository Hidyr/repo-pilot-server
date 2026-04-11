import { Hono } from "hono"
import { eq, inArray } from "drizzle-orm"
import { apiError } from "../http"
import { db, now } from "../db/client"
import { agents, schedules } from "../db/schema"
import { BUILTIN_AGENT_ORDER, isAgentPreset } from "../services/agent-presets"
import { runAgentSmokeTest, runAgentSmokeTestStreaming } from "../services/agent-smoke-test"
import { refreshSchedulerRegistrations } from "../services/scheduler.service"
import type { AgentPreset } from "../types"

export const agentsRouter = new Hono()

const BUILTIN_IDS = new Set<string>(["cursor", "claude_code", "codex"])

function assertBuiltinId(id: string): boolean {
  return BUILTIN_IDS.has(id)
}

agentsRouter.get("/", async (c) => {
  const list = await db.select().from(agents).all()
  const rank = new Map(BUILTIN_AGENT_ORDER.map((p, i) => [p, i]))
  list.sort(
    (a, b) =>
      (rank.get(a.preset as AgentPreset) ?? 99) - (rank.get(b.preset as AgentPreset) ?? 99)
  )
  return c.json({ data: list })
})

/** Register before `/:id/test` so `/test/stream` is not swallowed by a looser pattern. */
agentsRouter.post("/:id/test/stream", async (c) => {
  const id = c.req.param("id")
  if (!assertBuiltinId(id)) {
    return apiError(c, "NOT_FOUND", "Unknown agent", 404)
  }

  const agent = await db.select().from(agents).where(eq(agents.id, id)).get()
  if (!agent) return apiError(c, "NOT_FOUND", "Agent not found", 404)

  const preset = String((agent as { preset?: string }).preset ?? "")
  if (!isAgentPreset(preset)) {
    return apiError(c, "VALIDATION_ERROR", "Invalid agent preset", 400)
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`))
      }
      try {
        const result = await runAgentSmokeTestStreaming(preset, async (text, src, meta) => {
          send({ t: "chunk", stream: src, data: text, ...(meta ? { meta: true } : {}) })
        })
        await db
          .update(agents)
          .set({
            lastTestOk: result.ok,
            lastTestedAt: now(),
            lastTestOutput: result.ok ? result.message : result.error,
            updatedAt: now(),
          })
          .where(eq(agents.id, id))
          .run()
        await refreshSchedulerRegistrations()
        send(
          result.ok
            ? { t: "done", ok: true, message: result.message }
            : { t: "done", ok: false, error: result.error }
        )
      } catch (e) {
        await db
          .update(agents)
          .set({
            lastTestOk: false,
            lastTestedAt: now(),
            lastTestOutput: (e as Error)?.message ?? String(e),
            updatedAt: now(),
          })
          .where(eq(agents.id, id))
          .run()
        await refreshSchedulerRegistrations()
        send({
          t: "done",
          ok: false,
          error: (e as Error)?.message ?? String(e),
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  })
})

agentsRouter.post("/test", async (c) => {
  const body = (await c.req.json()) as { preset?: string }
  const preset = typeof body.preset === "string" ? body.preset.trim() : ""
  if (!preset || !isAgentPreset(preset)) {
    return apiError(c, "VALIDATION_ERROR", "preset must be cursor, claude_code, or codex", 400)
  }
  const result = await runAgentSmokeTest(preset)
  if (result.ok) {
    return c.json({ success: true, message: result.message })
  }
  return c.json({ success: false, error: result.error })
})

agentsRouter.put("/:id", async (c) => {
  const id = c.req.param("id")
  if (!assertBuiltinId(id)) {
    return apiError(c, "NOT_FOUND", "Unknown agent", 404)
  }

  const body = (await c.req.json()) as { enabled?: boolean }
  if (typeof body.enabled !== "boolean") {
    return apiError(c, "VALIDATION_ERROR", "enabled (boolean) is required", 400)
  }

  const existing = await db.select().from(agents).where(eq(agents.id, id)).get()
  if (!existing) return apiError(c, "NOT_FOUND", "Agent not found", 404)

  if (body.enabled === true) {
    await db
      .update(agents)
      .set({ enabled: false, updatedAt: now() })
      .where(inArray(agents.id, ["cursor", "claude_code", "codex"]))
      .run()
  }

  await db
    .update(agents)
    .set({ enabled: body.enabled, updatedAt: now() })
    .where(eq(agents.id, id))
    .run()

  const updated = await db.select().from(agents).where(eq(agents.id, id)).get()
  await refreshSchedulerRegistrations()
  return c.json({ data: updated })
})

agentsRouter.post("/:id/deactivate", async (c) => {
  const id = c.req.param("id")
  if (!assertBuiltinId(id)) {
    return apiError(c, "NOT_FOUND", "Unknown agent", 404)
  }

  const existing = await db.select().from(agents).where(eq(agents.id, id)).get()
  if (!existing) return apiError(c, "NOT_FOUND", "Agent not found", 404)

  // Remove from any project schedule selection.
  await db.update(schedules).set({ agentId: null, updatedAt: now() } as any).where(eq(schedules.agentId, id)).run()

  // Reset to "never added/tested".
  await db
    .update(agents)
    .set({
      enabled: false,
      lastTestOk: false,
      lastTestedAt: null,
      lastTestOutput: null,
      updatedAt: now(),
    } as any)
    .where(eq(agents.id, id))
    .run()

  const updated = await db.select().from(agents).where(eq(agents.id, id)).get()
  await refreshSchedulerRegistrations()
  return c.json({ data: updated })
})

agentsRouter.post("/:id/test", async (c) => {
  const id = c.req.param("id")
  if (!assertBuiltinId(id)) {
    return apiError(c, "NOT_FOUND", "Unknown agent", 404)
  }

  const agent = await db.select().from(agents).where(eq(agents.id, id)).get()
  if (!agent) return apiError(c, "NOT_FOUND", "Agent not found", 404)

  const preset = String((agent as { preset?: string }).preset ?? "")
  const result = await runAgentSmokeTest(preset)
  await db
    .update(agents)
    .set({
      lastTestOk: result.ok,
      lastTestedAt: now(),
      lastTestOutput: result.ok ? result.message : result.error,
      updatedAt: now(),
    })
    .where(eq(agents.id, id))
    .run()
  await refreshSchedulerRegistrations()
  if (result.ok) {
    return c.json({ success: true, message: result.message })
  }
  return c.json({ success: false, error: result.error })
})
