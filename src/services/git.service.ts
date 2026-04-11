import { existsSync, readFileSync, statSync } from "node:fs"
import { join, normalize } from "node:path"
import simpleGit, { type SimpleGit } from "simple-git"

import type { GitRunStartMode } from "../types"

const git = (localPath: string): SimpleGit => simpleGit(localPath)

/**
 * Resolve the git directory for a work tree (handles `.git` dir, `.git` file + worktrees).
 */
function resolveGitDir(workTreeRoot: string): string | null {
  const dotGit = join(workTreeRoot, ".git")
  if (!existsSync(dotGit)) return null
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return dotGit
    if (st.isFile()) {
      const line = (readFileSync(dotGit, "utf8").split(/\r?\n/)[0] ?? "").trim()
      const m = /^gitdir:\s*(.+)$/i.exec(line)
      if (!m) return null
      const p = m[1]!.trim()
      return normalize(p.startsWith("/") ? p : join(workTreeRoot, p))
    }
  } catch {
    return null
  }
  return null
}

/** Git config for remotes usually lives in the common git dir (main repo), not always in a linked worktree. */
function configDirForGitDir(gitDir: string): string {
  const commondirFile = join(gitDir, "commondir")
  if (!existsSync(commondirFile)) return gitDir
  try {
    const rel = readFileSync(commondirFile, "utf8").trim()
    if (!rel) return gitDir
    return normalize(join(gitDir, rel))
  } catch {
    return gitDir
  }
}

function readOriginFromConfigFile(configPath: string): { remoteUrl?: string; remoteName?: string } {
  try {
    if (!existsSync(configPath)) return {}
    const text = readFileSync(configPath, "utf8")
    const originBlock = text.match(/\[remote "origin"\][\s\S]*?(?=\n\[|\n*$)/i)
    if (originBlock) {
      const urlM = /^\s*url\s*=\s*(.+)\s*$/m.exec(originBlock[0])
      if (urlM) {
        let u = urlM[1]!.trim()
        if ((u.startsWith('"') && u.endsWith('"')) || (u.startsWith("'") && u.endsWith("'"))) {
          u = u.slice(1, -1)
        }
        return { remoteUrl: u, remoteName: "origin" }
      }
    }
    const anyRemote = text.match(/\[remote "([^"]+)"\][\s\S]*?^\s*url\s*=\s*(.+)\s*$/m)
    if (anyRemote) {
      let u = anyRemote[2]!.trim()
      if ((u.startsWith('"') && u.endsWith('"')) || (u.startsWith("'") && u.endsWith("'"))) {
        u = u.slice(1, -1)
      }
      return { remoteUrl: u, remoteName: anyRemote[1] }
    }
  } catch {
    /* ignore */
  }
  return {}
}

function readBranchFromGitDir(gitDir: string): string | undefined {
  try {
    const headPath = join(gitDir, "HEAD")
    if (!existsSync(headPath)) return undefined
    const raw = readFileSync(headPath, "utf8").trim()
    const refM = /^ref: refs\/heads\/(.+)$/.exec(raw)
    if (refM) return refM[1]!
    if (/^[0-9a-f]{7,40}$/i.test(raw)) return raw
  } catch {
    /* ignore */
  }
  return undefined
}

export async function gitPull(localPath: string): Promise<void> {
  await git(localPath).pull()
}

export async function gitAddAll(localPath: string): Promise<void> {
  await git(localPath).add(".")
}

export async function gitHasUncommittedChanges(localPath: string): Promise<boolean> {
  const status = await git(localPath).status()
  return !status.isClean()
}

export async function gitCommit(localPath: string, message: string): Promise<string> {
  const result = await git(localPath).commit(message)
  return result.commit
}

export async function gitPush(localPath: string): Promise<void> {
  await git(localPath).push()
}

export async function gitMergeToDefault(localPath: string, defaultBranch: string): Promise<void> {
  const g = git(localPath)
  const currentBranch = (await g.revparse(["--abbrev-ref", "HEAD"])).trim()
  if (currentBranch === defaultBranch) return
  await g.checkout(defaultBranch)
  await g.pull()
  await g.merge([
    currentBranch,
    "--no-ff",
    "-m",
    `Merge '${currentBranch}' into ${defaultBranch} via RepoPilot`,
  ])
  await g.checkout(currentBranch)
}

export async function gitClone(remoteUrl: string, localPath: string): Promise<void> {
  await simpleGit().clone(remoteUrl, localPath)
}

const MAX_REF_LEN = 200

/** Reject obviously unsafe ref names (path traversal, option injection). */
export function assertSafeGitRef(name: string): string {
  const t = name.trim()
  if (!t || t.length > MAX_REF_LEN) throw new Error("Invalid branch name")
  if (/[\r\n\0]/.test(t) || t.includes("..")) throw new Error("Invalid branch name")
  if (t.startsWith("-") || t.startsWith("@")) throw new Error("Invalid branch name")
  return t
}

/** Slug from feature title for a local branch name (no feat/bug prefix). */
export function branchNameFromFeatureTitle(title: string, featureId: string): string {
  let slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 120)
  if (!slug) {
    slug =
      featureId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-+/g, "-")
        .slice(0, 48) || "run"
  }
  return assertSafeGitRef(slug)
}

export async function gitCheckoutBranch(localPath: string, branch: string): Promise<void> {
  const b = assertSafeGitRef(branch)
  await git(localPath).checkout(b)
}

async function readCheckoutState(g: SimpleGit): Promise<{ ref: string; detached: boolean }> {
  const abbr = (await g.revparse(["--abbrev-ref", "HEAD"])).trim()
  if (abbr === "HEAD") {
    const oid = (await g.revparse(["HEAD"])).trim()
    return { ref: oid, detached: true }
  }
  return { ref: abbr, detached: false }
}

async function restoreCheckoutState(g: SimpleGit, state: { ref: string; detached: boolean }): Promise<void> {
  await g.checkout(state.ref)
}

/**
 * Prepares the repo checkout before an automated feature run.
 * - `current`: optional pull on the current branch (no restore).
 * - `from_base`: checkout default branch, optional pull, create/reset a branch named from the feature title (slug) from HEAD, restore previous ref when `finish()` runs.
 * - `branch`: checkout `workBranch`, optional pull, restore previous ref when `finish()` runs.
 */
export async function prepareAutomationGitWorkspace(
  localPath: string,
  params: {
    mode: GitRunStartMode
    workBranch: string | null
    defaultBranch: string | null
    autoPull: boolean
    featureTitle: string
    featureId: string
  },
  log: (line: string) => void | Promise<void>
): Promise<null | (() => Promise<void>)> {
  const g = git(localPath)
  const write = async (line: string) => {
    await log(line)
  }

  if (params.mode === "current") {
    if (params.autoPull) {
      await write("[GIT] Pulling latest changes...")
      await gitPull(localPath)
      await write("[GIT] Pull complete.")
    }
    return null
  }

  const prior = await readCheckoutState(g)

  if (params.mode === "branch") {
    const name = params.workBranch?.trim()
    if (!name) throw new Error("GIT_RUN_BRANCH_REQUIRED")
    const b = assertSafeGitRef(name)
    try {
      await write(`[GIT] Checking out ${b}...`)
      await g.checkout(b)
      if (params.autoPull) {
        await write("[GIT] Pulling latest changes...")
        await gitPull(localPath)
        await write("[GIT] Pull complete.")
      }
    } catch (err) {
      try {
        await restoreCheckoutState(g, prior)
      } catch {
        /* ignore */
      }
      throw err
    }
    return async () => {
      await write(`[GIT] Restoring checkout (${prior.ref})...`)
      await restoreCheckoutState(g, prior)
    }
  }

  // from_base
  const baseNameRaw = params.defaultBranch?.trim() || "main"
  const base = assertSafeGitRef(baseNameRaw)
  try {
    await write(`[GIT] Starting from base branch ${base}...`)
    await g.checkout(base)
    if (params.autoPull) {
      await write("[GIT] Pulling latest changes...")
      await gitPull(localPath)
      await write("[GIT] Pull complete.")
    }
    const featBranch = branchNameFromFeatureTitle(params.featureTitle, params.featureId)
    await write(`[GIT] Using branch ${featBranch} from feature name (create/reset from ${base})...`)
    await g.checkout(["-B", featBranch])
  } catch (err) {
    try {
      await restoreCheckoutState(g, prior)
    } catch {
      /* ignore */
    }
    throw err
  }
  return async () => {
    await write(`[GIT] Restoring checkout (${prior.ref})...`)
    await restoreCheckoutState(g, prior)
  }
}

/** Local branches and current checkout (branch name, or short sha when detached). */
export async function gitListLocalBranches(
  localPath: string
): Promise<{ current: string; branches: string[] }> {
  const g = git(localPath)
  const summary = await g.branchLocal()
  const branches = [...summary.all].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  let abbrev = (await g.revparse(["--abbrev-ref", "HEAD"])).trim()
  let current = abbrev
  if (current === "HEAD") {
    current = (await g.revparse(["--short", "HEAD"])).trim()
  }
  const set = new Set(branches)
  if (current && !set.has(current)) {
    branches.push(current)
    branches.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  }
  return { current, branches }
}

export async function detectGitInfo(localPath: string): Promise<{
  isGitRepo: boolean
  remoteUrl?: string
  remoteName?: string
  branch?: string
  defaultBranch?: string
}> {
  const gitDir = resolveGitDir(localPath)
  if (!gitDir) return { isGitRepo: false }

  const configDir = configDirForGitDir(gitDir)
  const configPath = join(configDir, "config")
  const fsFallback = () => {
    const { remoteUrl, remoteName } = readOriginFromConfigFile(configPath)
    const branch = readBranchFromGitDir(gitDir)
    return {
      isGitRepo: true as const,
      remoteUrl,
      remoteName,
      branch,
      defaultBranch: branch,
    }
  }

  try {
    const g = git(localPath)
    const isRepo = await g.checkIsRepo()
    if (!isRepo) {
      return fsFallback()
    }
    const remotes = await g.getRemotes(true)
    const origin = remotes.find((r) => r.name === "origin") ?? remotes[0]
    let branch = (await g.revparse(["--abbrev-ref", "HEAD"])).trim()
    if (branch === "HEAD") {
      branch = readBranchFromGitDir(gitDir) ?? branch
    }
    const defaultBranch = branch
    return {
      isGitRepo: true,
      remoteUrl: origin?.refs?.fetch,
      remoteName: origin?.name,
      branch,
      defaultBranch,
    }
  } catch (e) {
    console.warn(
      "[detectGitInfo] git CLI/simple-git failed; using .git metadata fallback:",
      (e as Error)?.message ?? e
    )
    return fsFallback()
  }
}

