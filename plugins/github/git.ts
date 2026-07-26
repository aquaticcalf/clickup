import type { ExecResult } from "@earendil-works/pi-coding-agent"

export type Runner = (
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>

export interface RepositoryStatus {
  root: string
  branch: string | undefined
  commit: string
  shortCommit: string
  dirtyFiles: string[]
  upstream: string | undefined
  ahead: number | undefined
  behind: number | undefined
  origin: string | undefined
}

export interface CheckoutState {
  repoRoot: string
  originalBranch?: string
  originalCommit: string
  prNumber: number
}

export class GitService {
  constructor(private readonly run: Runner) {}

  async git(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    timeout = 30_000,
  ): Promise<ExecResult> {
    return this.run("git", args, { cwd, signal, timeout })
  }

  async checked(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    timeout = 30_000,
  ): Promise<string> {
    const result = await this.git(args, cwd, signal, timeout)
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim()
      throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`)
    }
    return result.stdout.trim()
  }

  async status(cwd: string, signal?: AbortSignal): Promise<RepositoryStatus> {
    const root = await this.checked(["rev-parse", "--show-toplevel"], cwd, signal)
    const commit = await this.checked(["rev-parse", "HEAD"], root, signal)
    const branchResult = await this.git(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      root,
      signal,
    )
    const upstreamResult = await this.git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      root,
      signal,
    )
    const originResult = await this.git(["remote", "get-url", "origin"], root, signal)
    const status = await this.checked(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      root,
      signal,
    )

    let ahead: number | undefined
    let behind: number | undefined
    if (upstreamResult.code === 0 && upstreamResult.stdout.trim()) {
      const counts = await this.git(
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        root,
        signal,
      )
      if (counts.code === 0) {
        const [aheadText, behindText] = counts.stdout.trim().split(/\s+/)
        ahead = Number.parseInt(aheadText ?? "", 10)
        behind = Number.parseInt(behindText ?? "", 10)
      }
    }

    return {
      root,
      branch: branchResult.code === 0 ? branchResult.stdout.trim() || undefined : undefined,
      commit,
      shortCommit: commit.slice(0, 12),
      dirtyFiles: status ? status.split("\n").filter(Boolean) : [],
      upstream: upstreamResult.code === 0 ? upstreamResult.stdout.trim() || undefined : undefined,
      ahead,
      behind,
      origin: originResult.code === 0 ? originResult.stdout.trim() || undefined : undefined,
    }
  }

  async checkoutPullRequest(number: number, cwd: string, signal?: AbortSignal): Promise<void> {
    const result = await this.run("gh", ["pr", "checkout", String(number), "--detach"], {
      cwd,
      signal,
      timeout: 120_000,
    })
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim()
      throw new Error(`Could not checkout PR #${number}${detail ? `: ${detail}` : ""}`)
    }
  }

  async switchBack(state: CheckoutState, cwd: string, signal?: AbortSignal): Promise<void> {
    const status = await this.status(cwd, signal)
    if (status.dirtyFiles.length > 0) {
      throw new Error(
        "The PR checkout has changes. Commit or remove them before returning to the original branch.",
      )
    }
    if (state.originalBranch) {
      await this.checked(["switch", state.originalBranch], status.root, signal, 60_000)
    } else {
      await this.checked(["switch", "--detach", state.originalCommit], status.root, signal, 60_000)
    }
  }

  async pushCurrent(cwd: string, signal?: AbortSignal): Promise<string> {
    const status = await this.status(cwd, signal)
    if (!status.branch) throw new Error("Cannot push while HEAD is detached.")
    const args = status.upstream ? ["push"] : ["push", "--set-upstream", "origin", status.branch]
    const result = await this.git(args, status.root, signal, 120_000)
    if (result.code !== 0)
      throw new Error((result.stderr || result.stdout).trim() || "Push failed.")
    return (result.stdout || "Push completed.").trim()
  }

  async commitAll(message: string, cwd: string, signal?: AbortSignal): Promise<void> {
    const status = await this.status(cwd, signal)
    if (status.dirtyFiles.length === 0) throw new Error("There are no changes to commit.")
    const add = await this.git(["add", "-A"], status.root, signal, 60_000)
    if (add.code !== 0)
      throw new Error((add.stderr || add.stdout).trim() || "Could not stage changes.")
    const commit = await this.git(["commit", "-m", message], status.root, signal, 120_000)
    if (commit.code !== 0)
      throw new Error((commit.stderr || commit.stdout).trim() || "Could not create commit.")
  }
}
