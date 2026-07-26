import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionCommandContext,
  truncateHead,
} from "@earendil-works/pi-coding-agent"
import { GitService, type CheckoutState, type RepositoryStatus, type Runner } from "./git.ts"
import { GitHubService, type IssueSummary } from "./github.ts"
import { createGithubMenu, type GithubMenuActions } from "./ui.ts"

export interface PluginSettings {
  dirtyPolicy: "refuse" | "offer-commit"
  warnUnpushed: boolean
  confirmBranchChanges: boolean
  autoRefresh: boolean
}

interface PersistedState {
  settings?: PluginSettings
  checkout?: CheckoutState
}

const DEFAULT_SETTINGS: PluginSettings = {
  dirtyPolicy: "refuse",
  warnUnpushed: true,
  confirmBranchChanges: true,
  autoRefresh: true,
}

const STATE_ENTRY = "github-plugin-state"

function cloneSettings(settings: PluginSettings): PluginSettings {
  return { ...settings }
}

function output(text: string): string {
  const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES })
  if (!result.truncated) return result.content
  return `${result.content}\n\n[Output truncated: ${result.outputLines} of ${result.totalLines} lines (${result.outputBytes} of ${result.totalBytes} bytes).]`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatStatus(status: RepositoryStatus): string {
  const tracking = status.upstream
    ? `${status.upstream} · ahead ${status.ahead ?? 0}, behind ${status.behind ?? 0}`
    : "no upstream"
  return [
    `Root: ${status.root}`,
    `Branch: ${status.branch ?? "(detached HEAD)"}`,
    `Commit: ${status.shortCommit}`,
    `Working tree: ${status.dirtyFiles.length === 0 ? "clean" : `${status.dirtyFiles.length} changed path(s)`}`,
    `Tracking: ${tracking}`,
  ].join("\n")
}

function loadState(ctx: ExtensionCommandContext): PersistedState {
  let state: PersistedState = {}
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue
    if (entry.data && typeof entry.data === "object") state = entry.data as PersistedState
  }
  return state
}

function saveState(
  pi: ExtensionAPI,
  settings: PluginSettings,
  checkout: CheckoutState | undefined,
): void {
  pi.appendEntry<PersistedState>(STATE_ENTRY, { settings: cloneSettings(settings), checkout })
}

function makeRunner(pi: ExtensionAPI): Runner {
  return (command, args, options) => pi.exec(command, args, options)
}

export default function github(pi: ExtensionAPI): void {
  const runner = makeRunner(pi)
  const git = new GitService(runner)
  const githubApi = new GitHubService(runner)
  let settings = cloneSettings(DEFAULT_SETTINGS)
  let checkout: CheckoutState | undefined
  let issueCache: IssueSummary[] = []

  const save = (): void => saveState(pi, settings, checkout)

  const withStatus = async (ctx: ExtensionCommandContext): Promise<RepositoryStatus> =>
    git.status(ctx.cwd, ctx.signal)

  const confirmChange = async (
    ctx: ExtensionCommandContext,
    title: string,
    message: string,
  ): Promise<boolean> => {
    if (!settings.confirmBranchChanges) return true
    return ctx.ui.confirm(title, message)
  }

  const prepareCleanCheckout = async (ctx: ExtensionCommandContext): Promise<RepositoryStatus> => {
    let status = await withStatus(ctx)
    if (status.dirtyFiles.length > 0) {
      if (settings.dirtyPolicy === "refuse") {
        throw new Error(
          `Working tree is not clean (${status.dirtyFiles.length} changed path(s)). Commit your work before checking out a PR.`,
        )
      }
      const commit = await ctx.ui.confirm(
        "Commit current work?",
        `This will stage and commit all ${status.dirtyFiles.length} changed path(s). No push will be performed.`,
      )
      if (!commit) throw new Error("PR checkout cancelled; current changes were not committed.")
      const message = await ctx.ui.input("Commit message", "Checkpoint before checking out PR")
      if (!message?.trim())
        throw new Error("PR checkout cancelled; no commit message was supplied.")
      await git.commitAll(message.trim(), status.root, ctx.signal)
      status = await withStatus(ctx)
    }
    if (status.dirtyFiles.length > 0)
      throw new Error("Working tree is still dirty after the commit attempt.")
    return status
  }

  const checkoutPullRequest = async (
    ctx: ExtensionCommandContext,
    number: number,
  ): Promise<string | undefined> => {
    if (!Number.isInteger(number) || number < 1) throw new Error("Invalid pull-request number.")
    const status = await prepareCleanCheckout(ctx)
    const confirmed = await confirmChange(
      ctx,
      `Checkout PR #${number}?`,
      `Detach the current directory at PR #${number}.`,
    )
    if (!confirmed) return
    if (checkout)
      throw new Error(`Already tracking PR #${checkout.prNumber}. Return from it first.`)

    await git.checkoutPullRequest(number, status.root, ctx.signal)
    checkout = {
      repoRoot: status.root,
      originalBranch: status.branch,
      originalCommit: status.commit,
      prNumber: number,
    }
    save()
    const warning =
      settings.warnUnpushed && (status.ahead ?? 0) > 0
        ? `\n\nNote: the original branch had ${status.ahead} unpushed commit(s).`
        : ""
    return `Checked out PR #${number} in detached HEAD mode.${warning}`
  }

  const actions = (ctx: ExtensionCommandContext): GithubMenuActions => ({
    listPullRequests: () => githubApi.listPullRequests(ctx.cwd, ctx.signal),
    checkoutPullRequest: (number) => checkoutPullRequest(ctx, number),
    checkoutByNumber: (number) => checkoutPullRequest(ctx, number),
    returnFromPullRequest: async () => {
      if (!checkout) throw new Error("No PR checkout is recorded for this session.")
      const confirmed = await confirmChange(
        ctx,
        "Return from PR?",
        "Return to the original branch.",
      )
      if (!confirmed) return
      await git.switchBack(checkout, ctx.cwd, ctx.signal)
      checkout = undefined
      save()
      return "Returned to the original branch."
    },
    refreshPullRequests: async () => {
      const prs = await githubApi.listPullRequests(ctx.cwd, ctx.signal)
      return `Loaded ${prs.length} open pull request(s).`
    },
    showStatus: async () => {
      const status = await withStatus(ctx)
      const ghAvailable = await githubApi.isAvailable(ctx.cwd)
      const lines = [
        formatStatus(status),
        `GitHub CLI: ${ghAvailable ? "available" : "not found"}`,
        checkout ? `Tracked PR: #${checkout.prNumber}` : "Tracked PR: none",
      ]
      if (ghAvailable) {
        lines.push(`Auth: ${await githubApi.authStatus(ctx.cwd)}`)
        try {
          const repo = await githubApi.repository(ctx.cwd)
          lines.push(`Repository: ${repo.nameWithOwner}`)
        } catch (error) {
          lines.push(`Repository: ${errorText(error)}`)
        }
        const currentPr = await githubApi.currentPullRequest(ctx.cwd, ctx.signal)
        lines.push(
          currentPr ? `Current PR: #${currentPr.number} ${currentPr.title}` : "Current PR: none",
        )
      }
      return output(lines.join("\n"))
    },
    showPullRequest: (number) =>
      githubApi.pullRequestDetails(number, ctx.cwd, ctx.signal).then(output),
    showDiff: (number) => githubApi.pullRequestDiff(number, ctx.cwd, ctx.signal).then(output),
    openPullRequest: async (number) => {
      await githubApi.openPullRequest(number, ctx.cwd)
      return `Opened PR #${number} in the browser.`
    },
    openRepository: async () => {
      await githubApi.openRepository(ctx.cwd)
      return "Opened the repository in the browser."
    },
    showChecks: (number) => githubApi.checks(number, ctx.cwd, ctx.signal).then(output),
    waitForChecks: (number) => githubApi.waitForChecks(number, ctx.cwd, ctx.signal).then(output),
    listIssues: (query) => githubApi.listIssues(ctx.cwd, query, ctx.signal),
    showIssue: (number) => githubApi.issueDetails(number, ctx.cwd, ctx.signal).then(output),
    openIssue: async (number) => {
      await githubApi.checked(["issue", "view", String(number), "--web"], ctx.cwd, ctx.signal)
      return `Opened issue #${number} in the browser.`
    },
    createPullRequest: async () => {
      const status = await withStatus(ctx)
      if (!status.branch) throw new Error("Cannot create a PR while HEAD is detached.")
      const confirmed = await confirmChange(
        ctx,
        "Create pull request?",
        `Create a PR from ${status.branch}?`,
      )
      if (!confirmed) return
      const title = await ctx.ui.input("PR title", "Describe the change")
      if (!title?.trim()) return
      const body = await ctx.ui.editor("PR description", "")
      if (body === undefined) return
      const url = await githubApi.createPullRequest(title.trim(), body, ctx.cwd, ctx.signal)
      return `Created pull request: ${url}`
    },
    pushCurrentBranch: async () => {
      const confirmed = await confirmChange(
        ctx,
        "Push current branch?",
        "This will push local commits to the configured upstream.",
      )
      if (!confirmed) return
      return git.pushCurrent(ctx.cwd, ctx.signal)
    },
    editPullRequest: async (number) => {
      const confirmed = await confirmChange(ctx, "Edit PR?", `Modify metadata for PR #${number}?`)
      if (!confirmed) return
      const title = await ctx.ui.input("New PR title", "Leave blank to keep the current title")
      const body = await ctx.ui.editor("New PR description", "")
      const args: string[] = []
      if (title?.trim()) args.push("--title", title.trim())
      if (body !== undefined) args.push("--body", body)
      if (args.length === 0) return
      return githubApi.editPullRequest(number, args, ctx.cwd, ctx.signal)
    },
    commentOnPullRequest: async (number) => {
      const confirmed = await confirmChange(
        ctx,
        "Comment on PR?",
        `Post a comment on PR #${number}?`,
      )
      if (!confirmed) return
      const body = await ctx.ui.editor("PR comment", "")
      if (!body?.trim()) return
      return githubApi.commentOnPullRequest(number, body, ctx.cwd, ctx.signal)
    },
    setPullRequestState: async (number, state) => {
      const confirmed = await confirmChange(
        ctx,
        `${state === "close" ? "Close" : "Reopen"} PR?`,
        `Change PR #${number} to ${state}?`,
      )
      if (!confirmed) return
      return githubApi.setPullRequestState(number, state, ctx.cwd, ctx.signal)
    },
    markPullRequestReady: async (number) => {
      const confirmed = await confirmChange(
        ctx,
        "Mark PR ready?",
        `Mark PR #${number} ready for review?`,
      )
      if (!confirmed) return
      return githubApi.markReady(number, ctx.cwd, ctx.signal)
    },
    mergePullRequest: async (number, method) => {
      const confirmed = await confirmChange(
        ctx,
        "Merge pull request?",
        `Merge PR #${number} using ${method}? This cannot usually be undone.`,
      )
      if (!confirmed) return
      return githubApi.mergePullRequest(number, method, ctx.cwd, ctx.signal)
    },
    saveSettings: (next) => {
      settings = cloneSettings(next)
      save()
    },
  })

  const openMenu = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/github requires TUI mode.", "error")
      return
    }
    if (!(await githubApi.isAvailable(ctx.cwd))) {
      ctx.ui.notify("GitHub CLI (gh) is not installed or unavailable.", "error")
      return
    }
    await ctx.ui.custom<void>((tui, _theme, _keybindings, done) =>
      createGithubMenu(ctx, settings, actions(ctx), tui, done),
    )
  }

  pi.registerCommand("github", {
    description: "Open the GitHub PR, checks, issues, and repository menu",
    handler: openMenu,
  })

  pi.on("session_start", async (_event, ctx) => {
    const state = loadState(ctx as ExtensionCommandContext)
    settings = { ...DEFAULT_SETTINGS, ...state.settings }
    checkout = state.checkout
    if (ctx.mode !== "tui") return

    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["#"],
      async getSuggestions(lines, line, col, options) {
        const before = (lines[line] ?? "").slice(0, col)
        const match = before.match(/(?:^|[ \t])#([^\s#]*)$/)
        if (!match) return current.getSuggestions(lines, line, col, options)
        if (settings.autoRefresh && issueCache.length === 0) {
          try {
            issueCache = await githubApi.listIssues(ctx.cwd)
          } catch {
            issueCache = []
          }
        }
        const term = (match[1] ?? "").toLowerCase()
        return {
          prefix: `#${match[1] ?? ""}`,
          items: issueCache
            .filter((issue) => `${issue.number} ${issue.title}`.toLowerCase().includes(term))
            .slice(0, 20)
            .map((issue) => ({
              value: `#${issue.number}`,
              label: `#${issue.number}`,
              description: issue.title,
            })),
        }
      },
      applyCompletion(lines, line, col, item, prefix) {
        return current.applyCompletion(lines, line, col, item, prefix)
      },
      shouldTriggerFileCompletion(lines, line, col) {
        return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true
      },
    }))

    if (settings.autoRefresh) {
      void githubApi
        .listIssues(ctx.cwd)
        .then((issues) => {
          issueCache = issues
        })
        .catch(() => undefined)
    }
  })
}
