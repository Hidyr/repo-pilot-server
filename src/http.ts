import type { Context } from "hono"

export function apiError(c: Context, code: string, message: string, status: number) {
  return c.json({ error: { code, message } }, status)
}

