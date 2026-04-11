import { and, eq } from "drizzle-orm"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { db, uuid } from "../db/client"
import { agents } from "../db/schema"
import type { Agent, AgentPreset } from "../types"
import { BUILTIN_AGENT_ORDER, isAgentPreset, presetSpawnConfig } from "./agent-presets"

export async function getEnabledAgent(): Promise<Agent | null> {
  const rows = await db.select().from(agents).where(eq(agents.enabled, true)).all()
  if (rows.length === 0) return null
  const rank = new Map(BUILTIN_AGENT_ORDER.map((p, i) => [p, i]))
  rows.sort(
    (a, b) =>
      (rank.get(a.preset as AgentPreset) ?? 99) - (rank.get(b.preset as AgentPreset) ?? 99)
  )
  return (rows[0] as Agent) ?? null
}

/** Enabled agents that passed a successful smoke test (used for automation and queue runs). */
export async function getRunnableAgent(): Promise<Agent | null> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.enabled, true), eq(agents.lastTestOk, true)))
    .all()
  if (rows.length === 0) return null
  const rank = new Map(BUILTIN_AGENT_ORDER.map((p, i) => [p, i]))
  rows.sort(
    (a, b) =>
      (rank.get(a.preset as AgentPreset) ?? 99) - (rank.get(b.preset as AgentPreset) ?? 99)
  )
  return (rows[0] as Agent) ?? null
}

/** Agent that will run work for this schedule: explicit selection if tested, else first runnable default. */
export async function resolveAgentForSchedule(schedule: {
  agentId: string | null
}): Promise<Agent | null> {
  if (schedule.agentId) {
    const a = await getAgentById(schedule.agentId)
    if (!a) return null
    if (!(a as { enabled?: boolean }).enabled || !(a as { lastTestOk?: boolean }).lastTestOk) {
      return null
    }
    return a as Agent
  }
  return getRunnableAgent()
}

export async function resolveAgentIdForSchedule(schedule: {
  agentId: string | null
}): Promise<string | null> {
  const a = await resolveAgentForSchedule(schedule)
  return a?.id ?? null
}

export async function getAgentById(agentId: string): Promise<Agent | null> {
  const row = await db.select().from(agents).where(eq(agents.id, agentId)).get()
  return (row as any) ?? null
}

export function buildAgentCommand(
  agent: Agent,
  promptFile: string,
  workingDir: string
): { command: string; args: string[] } {
  const presetRaw = String((agent as any).preset ?? "")
  if (!isAgentPreset(presetRaw)) {
    throw new Error(`AGENT_PRESET_INVALID:${presetRaw || "(empty)"}`)
  }
  return presetSpawnConfig(presetRaw, { promptFile, workingDir })
}

export async function runAgent(prompt: string, workingDir: string): Promise<{
  success: boolean
  logs: string
  error?: string
}> {
  let logs = ""
  const result = await runAgentStreaming(prompt, workingDir, {
    onOutput: (chunk) => {
      logs += chunk
    },
  })
  return { ...result, logs }
}

export async function runAgentStreaming(
  prompt: string,
  workingDir: string,
  opts?: {
    agentId?: string | null
    signal?: AbortSignal
    onOutput?: (chunk: string) => void | Promise<void>
  }
): Promise<{ success: boolean; logs: string; error?: string }> {
  const agent = opts?.agentId ? await getAgentById(opts.agentId) : await getRunnableAgent()
  if (!agent) throw new Error("AGENT_NOT_FOUND")

  const promptFile = join(tmpdir(), `repopilot-${Date.now()}-${uuid()}.txt`)
  await Bun.write(promptFile, prompt)

  const { command, args } = buildAgentCommand(agent, promptFile, workingDir)
  console.log(`Built command for agent ${agent.id}: ${command} ${args.join(" ")}`)
  const proc = Bun.spawn([command, ...args], {
    cwd: workingDir,
    stdout: "pipe",
    stderr: "pipe",
  })

  console.log(`Spawned agent process with PID ${proc.pid}: ${command} ${args.join(" ")}`)

  const onOutput = opts?.onOutput
  const signal = opts?.signal

  const abort = () => {
    try {
      proc.kill("SIGTERM")
    } catch {
      /* ignore */
    }
  }

  if (signal) {
    if (signal.aborted) abort()
    signal.addEventListener("abort", abort, { once: true })
  }

  let logs = ""
  const consume = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = new TextDecoder().decode(value)
      logs += chunk
      if (onOutput) await onOutput(chunk)
    }
  }

  await Promise.all([consume(proc.stdout), consume(proc.stderr)])
  const exitCode = await proc.exited

  await unlink(promptFile).catch(() => {})

  if (signal) signal.removeEventListener("abort", abort as any)

  if (signal?.aborted) {
    return { success: false, logs, error: "CANCELLED" }
  }
  if (exitCode === 0) return { success: true, logs }
  return { success: false, logs, error: `Exit code ${exitCode}` }
}

