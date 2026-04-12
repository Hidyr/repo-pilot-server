import type { AgentPreset } from "../types"
import { agentSpawnEnv, resolvedAgentExecutable } from "./agent-cli-env"
import { isAgentPreset } from "./agent-presets"

const TIMEOUT_MS = 15_000

export type AgentSmokeResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

function extractVersion(output: string): string {
  const line =
    output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  // Keep the UI tidy.
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

async function readProcessOutput(proc: {
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
}): Promise<string> {
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return [out, err].filter(Boolean).join("\n").trim()
}

async function drainStream(
  stream: ReadableStream<Uint8Array> | null,
  source: "stdout" | "stderr",
  onChunk: (text: string, stream: "stdout" | "stderr") => void | Promise<void>
): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const dec = new TextDecoder()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value?.byteLength) {
        const text = dec.decode(value, { stream: true })
        await onChunk(text, source)
      }
    }
    const tail = dec.decode()
    if (tail) await onChunk(tail, source)
  } finally {
    reader.releaseLock()
  }
}

async function runAgentOnce(
  argv: string[],
  timeoutMs: number
): Promise<{ code: number; output: string; timedOut: boolean }> {
  const [cmd, ...args] = argv
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([cmd, ...args], {
      env: agentSpawnEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (e) {
    return {
      code: -1,
      output: (e as Error)?.message ?? String(e),
      timedOut: false,
    }
  }

  const outputPromise = readProcessOutput(proc)
  let timedOut = false
  const timeoutHit = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs)
  })

  const outcome = await Promise.race([
    proc.exited.then((code) => ({ kind: "exit" as const, code })),
    timeoutHit.then(() => ({ kind: "timeout" as const })),
  ])

  if (outcome.kind === "timeout") {
    timedOut = true
    try {
      proc.kill("SIGTERM")
    } catch {
      /* ignore */
    }
    await Promise.race([
      proc.exited,
      new Promise<void>((r) => setTimeout(r, 3_000)),
    ])
  }

  const code = outcome.kind === "exit" ? outcome.code : await proc.exited.catch(() => -1)
  const output = await outputPromise.catch(() => "")

  return { code, output, timedOut }
}

async function runAgentOnceStreaming(
  argv: string[],
  timeoutMs: number,
  onChunk: (text: string, stream: "stdout" | "stderr") => void | Promise<void>
): Promise<{ code: number; timedOut: boolean }> {
  const [cmd, ...args] = argv
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([cmd, ...args], {
      env: agentSpawnEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (e) {
    await onChunk(`${(e as Error)?.message ?? String(e)}\n`, "stderr")
    return { code: -1, timedOut: false }
  }

  const drainOut = drainStream(proc.stdout, "stdout", onChunk)
  const drainErr = drainStream(proc.stderr, "stderr", onChunk)

  const timeoutHit = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs)
  })

  const outcome = await Promise.race([
    proc.exited.then((code) => ({ kind: "exit" as const, code })),
    timeoutHit.then(() => ({ kind: "timeout" as const })),
  ])

  let timedOut = false
  if (outcome.kind === "timeout") {
    timedOut = true
    try {
      proc.kill("SIGTERM")
    } catch {
      /* ignore */
    }
  }

  await Promise.race([
    Promise.all([drainOut, drainErr]),
    new Promise<void>((r) => setTimeout(r, 5_000)),
  ])

  const code =
    outcome.kind === "exit" ? outcome.code : await proc.exited.catch(() => -1)

  return { code, timedOut }
}

function versionArgv(preset: AgentPreset): { command: string; args: string[] } {
  return { command: resolvedAgentExecutable(preset), args: ["--version"] }
}

export async function runAgentSmokeTest(preset: string): Promise<AgentSmokeResult> {
  if (!isAgentPreset(preset)) {
    return { ok: false, error: `Unknown preset: ${preset}` }
  }
  const { command, args } = versionArgv(preset as AgentPreset)
  const { code, output, timedOut } = await runAgentOnce([command, ...args], TIMEOUT_MS)
  if (timedOut) return { ok: false, error: `Timed out after ${TIMEOUT_MS / 1000}s running --version.` }
  if (code === 0) return { ok: true, message: extractVersion(output) || "" }
  return { ok: false, error: output || `Exit code ${code}` }
}

export async function runAgentSmokeTestStreaming(
  preset: string,
  onChunk: (text: string, stream: "stdout" | "stderr", meta?: boolean) => void | Promise<void>
): Promise<AgentSmokeResult> {
  if (!isAgentPreset(preset)) {
    return { ok: false, error: `Unknown preset: ${preset}` }
  }
  const { command, args } = versionArgv(preset as AgentPreset)
  let captured = ""
  await onChunk(`$ ${[command, ...args].join(" ")}\n\n`, "stderr", true)
  const { code, timedOut } = await runAgentOnceStreaming([command, ...args], TIMEOUT_MS, async (t, s) => {
    captured += t
    await onChunk(t, s)
  })
  await onChunk(`\n$ Process finished (exit ${code}${timedOut ? ", timed out" : ""})\n`, "stderr", true)
  if (timedOut) return { ok: false, error: `Timed out after ${TIMEOUT_MS / 1000}s running --version.` }
  if (code === 0) return { ok: true, message: extractVersion(captured) || "OK" }
  return { ok: false, error: `Exit code ${code}` }
}
