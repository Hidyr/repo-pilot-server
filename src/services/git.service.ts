import simpleGit, { type SimpleGit } from "simple-git"

const git = (localPath: string): SimpleGit => simpleGit(localPath)

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

export async function detectGitInfo(localPath: string): Promise<{
  isGitRepo: boolean
  remoteUrl?: string
  remoteName?: string
  branch?: string
  defaultBranch?: string
}> {
  try {
    const g = git(localPath)
    const isRepo = await g.checkIsRepo()
    if (!isRepo) return { isGitRepo: false }
    const remotes = await g.getRemotes(true)
    const origin = remotes.find((r) => r.name === "origin") ?? remotes[0]
    const branch = (await g.revparse(["--abbrev-ref", "HEAD"])).trim()
    const defaultBranch = branch
    return {
      isGitRepo: true,
      remoteUrl: origin?.refs?.fetch,
      remoteName: origin?.name,
      branch,
      defaultBranch,
    }
  } catch {
    return { isGitRepo: false }
  }
}

