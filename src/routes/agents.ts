import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { apiError } from "../http"
import { db, now, uuid } from "../db/client"
import { agents } from "../db/schema"

export const agentsRouter = new Hono()

agentsRouter.get("/", async (c) => {
  const list = await db.select().from(agents).all()
  return c.json({ data: list })
})

agentsRouter.post("/", async (c) => {
  const body = (await c.req.json()) as {
    name?: string
    type?: "cursor" | "claude-code" | "custom"
    commandPath?: string
  }
  if (!body.name || !body.type || !body.commandPath) {
    return apiError(c, "VALIDATION_ERROR", "name, type, commandPath are required", 400)
  }
  const row: any = {
    id: uuid(),
    name: body.name,
    type: body.type,
    commandPath: body.commandPath,
    enabled: true,
    createdAt: now(),
    updatedAt: now(),
  }
  await db.insert(agents).values(row).run()
  return c.json({ data: row })
})

agentsRouter.put("/:id", async (c) => {
  const id = c.req.param("id")
  const body = (await c.req.json()) as Record<string, unknown>
  const existing = await db.select().from(agents).where(eq(agents.id, id)).get()
  if (!existing) return apiError(c, "NOT_FOUND", "Agent not found", 404)
  await db
    .update(agents)
    .set({ ...body, updatedAt: now() } as any)
    .where(eq(agents.id, id))
    .run()
  const updated = await db.select().from(agents).where(eq(agents.id, id)).get()
  return c.json({ data: updated })
})

agentsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id")
  await db.delete(agents).where(eq(agents.id, id)).run()
  return c.json({ ok: true })
})

agentsRouter.post("/:id/test", async (c) => {
  const id = c.req.param("id")
  const agent = await db.select().from(agents).where(eq(agents.id, id)).get()
  if (!agent) return apiError(c, "NOT_FOUND", "Agent not found", 404)

  try {
    const proc = Bun.spawn([String((agent as any).commandPath), "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (code === 0) {
      return c.json({ success: true, version: (out || err || "").trim() })
    }
    return c.json({ success: false, error: (out || err || `Exit code ${code}`).trim() })
  } catch (e) {
    return c.json({ success: false, error: (e as any)?.message ?? String(e) })
  }
})

