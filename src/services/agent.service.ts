import { eq } from "drizzle-orm"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { db, uuid } from "../db/client"
import { agents } from "../db/schema"
import type { Agent } from "../types"

export async function getEnabledAgent(): Promise<Agent | null> {
  const row = await db.select().from(agents).where(eq(agents.enabled, true)).limit(1).get()
  return (row as any) ?? null
}

export function buildAgentCommand(agent: Agent, promptFile: string): { command: string; args: string[] } {
  switch (agent.type) {
    case "cursor":
      return { command: agent.commandPath, args: ["--prompt", promptFile] }
    case "claude-code":
      return { command: agent.commandPath, args: ["-p", promptFile] }
    case "custom":
      return { command: agent.commandPath, args: [promptFile] }
    default:
      return { command: agent.commandPath, args: [promptFile] }
  }
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
    signal?: AbortSignal
    onOutput?: (chunk: string) => void | Promise<void>
  }
): Promise<{ success: boolean; logs: string; error?: string }> {
  const agent = await getEnabledAgent()
  if (!agent) throw new Error("AGENT_NOT_FOUND")

  const promptFile = join(tmpdir(), `repopilot-${Date.now()}-${uuid()}.txt`)
  await Bun.write(promptFile, prompt)

  const { command, args } = buildAgentCommand(agent, promptFile)
  const proc = Bun.spawn([command, ...args], {
    cwd: workingDir,
    stdout: "pipe",
    stderr: "pipe",
  })

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

