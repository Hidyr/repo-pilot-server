import type { AgentPreset } from "../types"
import { resolvedAgentExecutable } from "./agent-cli-env"

/** Row ids — must match database primary keys for built-in agents. */
export const BUILTIN_AGENT_IDS = {
  cursor: "cursor",
  claude_code: "claude_code",
  codex: "codex",
} as const satisfies Record<AgentPreset, string>

export const BUILTIN_AGENT_ORDER: AgentPreset[] = ["cursor", "claude_code", "codex"]

export function isAgentPreset(value: string): value is AgentPreset {
  return value === "cursor" || value === "claude_code" || value === "codex"
}

export function builtinDisplayName(preset: AgentPreset): string {
  switch (preset) {
    case "cursor":
      return "Cursor"
    case "claude_code":
      return "Claude Code"
    case "codex":
      return "Codex"
  }
}

/**
 * How we invoke each CLI on the API host (non-interactive where possible).
 * Cursor needs an explicit trusted workspace path or it stops for “Workspace Trust”.
 */
export function presetSpawnConfig(
  preset: AgentPreset,
  ctx: { promptFile: string; workingDir: string }
): { command: string; args: string[] } {
  switch (preset) {
    case "cursor":
      return {
        command: resolvedAgentExecutable("cursor"),
        args: ["--print", "--force", "--trust", ctx.workingDir, ctx.promptFile],
      }
    case "claude_code":
      return {
        command: resolvedAgentExecutable("claude_code"),
        args: ["-p", ctx.promptFile],
      }
    case "codex":
      return {
        command: resolvedAgentExecutable("codex"),
        args: ["exec", "--full-auto", ctx.promptFile],
      }
  }
}
