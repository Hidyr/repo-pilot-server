import { existsSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"
import type { AgentPreset } from "../types"

/** Extra dirs prepended before `process.env.PATH` (mirrors desktop shell + common installs). */
function extraPathPrefixes(): string[] {
  const h = homedir()
  if (process.platform === "darwin") {
    return [
      "/Applications/Cursor.app/Contents/Resources/app/bin",
      path.join(h, "Applications", "Cursor.app", "Contents", "Resources", "app", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(h, ".local", "bin"),
      path.join(h, ".bun", "bin"),
      path.join(h, ".volta", "bin"),
    ]
  }
  if (process.platform === "win32") {
    const hp = process.env.USERPROFILE ?? ""
    return [
      path.join(hp, "AppData", "Local", "Programs", "Cursor", "resources", "app", "bin"),
      path.join(hp, ".bun", "bin"),
      path.join(hp, "AppData", "Roaming", "npm"),
    ]
  }
  return [path.join(h, ".local", "bin"), "/usr/local/bin", path.join(h, ".bun", "bin")]
}

function orderedPathDirs(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (d: string) => {
    const norm = path.normalize(d)
    if (!norm || seen.has(norm)) return
    seen.add(norm)
    out.push(norm)
  }
  for (const d of extraPathPrefixes()) push(d)
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (d) push(d)
  }
  return out
}

/** Environment for `Bun.spawn` so CLIs resolve like in Terminal (desktop API inherits a tiny PATH). */
export function agentSpawnEnv(): NodeJS.ProcessEnv {
  const prefix = extraPathPrefixes().join(path.delimiter)
  const base = process.env.PATH ?? ""
  const merged = base ? `${prefix}${path.delimiter}${base}` : prefix
  return { ...process.env, PATH: merged }
}

function findInPath(baseName: string): string | null {
  const win = process.platform === "win32"
  const names = win ? [`${baseName}.exe`, `${baseName}.cmd`, baseName] : [baseName]
  for (const dir of orderedPathDirs()) {
    for (const n of names) {
      const full = path.join(dir, n)
      try {
        if (existsSync(full)) return full
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

/** Prefer known install locations, then PATH, then the bare name (spawn may still find it). */
export function resolvedAgentExecutable(preset: AgentPreset): string {
  switch (preset) {
    case "cursor": {
      if (process.platform === "win32") {
        const hp = process.env.USERPROFILE ?? ""
        const w = path.join(
          hp,
          "AppData",
          "Local",
          "Programs",
          "Cursor",
          "resources",
          "app",
          "bin",
          "cursor-agent.exe"
        )
        if (existsSync(w)) return w
      } else {
        const mac = [
          "/Applications/Cursor.app/Contents/Resources/app/bin/cursor-agent",
          path.join(
            homedir(),
            "Applications",
            "Cursor.app",
            "Contents",
            "Resources",
            "app",
            "bin",
            "cursor-agent"
          ),
        ]
        for (const p of mac) {
          if (existsSync(p)) return p
        }
      }
      return findInPath("cursor-agent") ?? "cursor-agent"
    }
    case "claude_code":
      return findInPath("claude") ?? "claude"
    case "codex":
      return findInPath("codex") ?? "codex"
  }
}
