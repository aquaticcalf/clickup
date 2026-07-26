import type { ExecResult } from "@earendil-works/pi-coding-agent"
import type { Runner } from "./git.ts"

export interface PullRequestSummary {
  number: number
  title: string
  author: string
  isDraft: boolean
  reviewDecision: string
  checks: string
  url: string
  updatedAt: string
  headRefName?: string
  baseRefName?: string
}

export interface IssueSummary {
  number: number
  title: string
  author: string
  labels: string
  url: string
}

function value<T>(object: Record<string, unknown>, key: string): T | undefined {
  return object[key] as T | undefined
}

function stringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  return fallback
}

function parseJson<T>(result: ExecResult, command: string): T {
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`)
  }
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    throw new Error(`${command} returned invalid JSON.`)
  }
}

function checkSummary(rollup: unknown): string {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none"
  const states = rollup.map((check) => {
    if (!check || typeof check !== "object") return "unknown"
    const item = check as Record<string, unknown>
    return stringValue(item.conclusion ?? item.state ?? item.status, "unknown").toLowerCase()
  })
  if (
    states.some((state) => ["failure", "failed", "cancelled", "timed_out", "error"].includes(state))
  )
    return "failed"
  if (
    states.some((state) =>
      ["pending", "queued", "in_progress", "requested", "waiting"].includes(state),
    )
  )
    return "pending"
  if (states.every((state) => ["success", "completed", "passed"].includes(state))) return "passed"
  return states.join(", ")
}

export class GitHubService {
  constructor(private readonly run: Runner) {}

  async gh(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    timeout = 60_000,
  ): Promise<ExecResult> {
    return this.run("gh", args, { cwd, signal, timeout })
  }

  async checked(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    timeout = 60_000,
  ): Promise<string> {
    const result = await this.gh(args, cwd, signal, timeout)
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim()
      throw new Error(`gh ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`)
    }
    return result.stdout.trim()
  }

  async isAvailable(cwd: string): Promise<boolean> {
    const result = await this.run("gh", ["--version"], { cwd, timeout: 5_000 })
    return result.code === 0
  }

  async authStatus(cwd: string): Promise<string> {
    const result = await this.gh(["auth", "status"], cwd, undefined, 15_000)
    return (result.stdout || result.stderr).trim()
  }

  async repository(cwd: string): Promise<{ nameWithOwner: string; url: string }> {
    const data = parseJson<Record<string, unknown>>(
      await this.gh(["repo", "view", "--json", "nameWithOwner,url"], cwd),
      "gh repo view",
    )
    return {
      nameWithOwner: String(value(data, "nameWithOwner") ?? "unknown"),
      url: String(value(data, "url") ?? ""),
    }
  }

  async currentPullRequest(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ number: number; title: string; url: string } | undefined> {
    const result = await this.gh(["pr", "view", "--json", "number,title,url"], cwd, signal, 30_000)
    if (result.code !== 0) return undefined
    const data = parseJson<Record<string, unknown>>(result, "gh pr view")
    return {
      number: Number(value(data, "number") ?? 0),
      title: String(value(data, "title") ?? ""),
      url: String(value(data, "url") ?? ""),
    }
  }

  async listPullRequests(cwd: string, signal?: AbortSignal): Promise<PullRequestSummary[]> {
    const data = parseJson<Record<string, unknown>[]>(
      await this.gh(
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--json",
          "number,title,author,isDraft,reviewDecision,statusCheckRollup,url,updatedAt,headRefName,baseRefName",
        ],
        cwd,
        signal,
      ),
      "gh pr list",
    )
    return data.map((item) => ({
      number: Number(value(item, "number") ?? 0),
      title: String(value(item, "title") ?? "(untitled)"),
      author: stringValue(value<Record<string, unknown>>(item, "author")?.login, "unknown"),
      isDraft: Boolean(value(item, "isDraft")),
      reviewDecision: String(value(item, "reviewDecision") ?? "none").toLowerCase(),
      checks: checkSummary(value(item, "statusCheckRollup")),
      url: String(value(item, "url") ?? ""),
      updatedAt: String(value(item, "updatedAt") ?? ""),
      headRefName: String(value(item, "headRefName") ?? "") || undefined,
      baseRefName: String(value(item, "baseRefName") ?? "") || undefined,
    }))
  }

  async pullRequestDetails(number: number, cwd: string, signal?: AbortSignal): Promise<string> {
    const data = await this.checked(
      [
        "pr",
        "view",
        String(number),
        "--json",
        "number,title,body,author,isDraft,reviewDecision,statusCheckRollup,url,headRefName,baseRefName,mergeable,files,reviews,labels",
      ],
      cwd,
      signal,
    )
    const item = JSON.parse(data) as Record<string, unknown>
    const author = stringValue(value<Record<string, unknown>>(item, "author")?.login, "unknown")
    const files = Array.isArray(value(item, "files")) ? value<unknown[]>(item, "files")!.length : 0
    const labels = Array.isArray(value(item, "labels"))
      ? value<unknown[]>(item, "labels")!
          .map((label) =>
            typeof label === "object" && label
              ? stringValue((label as Record<string, unknown>).name)
              : "",
          )
          .filter(Boolean)
          .join(", ")
      : ""
    const body = String(value(item, "body") ?? "").trim() || "(no description)"
    return [
      `#${number} ${String(value(item, "title") ?? "(untitled)")}`,
      `Author: ${author}${value(item, "isDraft") ? " · draft" : ""}`,
      `Branch: ${String(value(item, "headRefName") ?? "?")} → ${String(value(item, "baseRefName") ?? "?")}`,
      `Review: ${String(value(item, "reviewDecision") ?? "none")} · Checks: ${checkSummary(value(item, "statusCheckRollup"))}`,
      `Mergeable: ${String(value(item, "mergeable") ?? "unknown")} · Files: ${files}`,
      labels ? `Labels: ${labels}` : "Labels: none",
      `URL: ${String(value(item, "url") ?? "")}`,
      "",
      body,
    ].join("\n")
  }

  async pullRequestDiff(number: number, cwd: string, signal?: AbortSignal): Promise<string> {
    return this.checked(["pr", "diff", String(number)], cwd, signal, 120_000)
  }

  async checks(number: number | undefined, cwd: string, signal?: AbortSignal): Promise<string> {
    const args = [
      "pr",
      "checks",
      ...(number ? [String(number)] : []),
      "--json",
      "name,state,bucket,link,workflow",
    ]
    const result = await this.gh(args, cwd, signal)
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim()
      throw new Error(`gh pr checks failed${detail ? `: ${detail}` : ""}`)
    }
    try {
      const checks = JSON.parse(result.stdout) as Record<string, unknown>[]
      if (checks.length === 0) return "No checks found."
      return checks
        .map((check) => {
          const state = stringValue(check.state ?? check.bucket, "unknown")
          const name = stringValue(check.name ?? check.workflow, "check")
          const link = stringValue(check.link)
          return `${state.padEnd(12)} ${name}${link ? `\n  ${link}` : ""}`
        })
        .join("\n")
    } catch {
      return result.stdout.trim()
    }
  }

  async waitForChecks(number: number, cwd: string, signal?: AbortSignal): Promise<string> {
    return this.checked(
      ["pr", "checks", String(number), "--watch", "--interval", "10"],
      cwd,
      signal,
      30 * 60_000,
    )
  }

  async listIssues(cwd: string, query?: string, signal?: AbortSignal): Promise<IssueSummary[]> {
    const data = parseJson<Record<string, unknown>[]>(
      await this.gh(
        [
          "issue",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          ...(query ? ["--search", query] : []),
          "--json",
          "number,title,author,labels,url",
        ],
        cwd,
        signal,
      ),
      "gh issue list",
    )
    return data.map((item) => ({
      number: Number(value(item, "number") ?? 0),
      title: String(value(item, "title") ?? "(untitled)"),
      author: stringValue(value<Record<string, unknown>>(item, "author")?.login, "unknown"),
      labels: Array.isArray(value(item, "labels"))
        ? value<unknown[]>(item, "labels")!
            .map((label) =>
              typeof label === "object" && label
                ? stringValue((label as Record<string, unknown>).name)
                : "",
            )
            .filter(Boolean)
            .join(", ")
        : "",
      url: String(value(item, "url") ?? ""),
    }))
  }

  async issueDetails(number: number, cwd: string, signal?: AbortSignal): Promise<string> {
    const data = await this.checked(
      ["issue", "view", String(number), "--json", "number,title,body,author,labels,url,state"],
      cwd,
      signal,
    )
    const item = JSON.parse(data) as Record<string, unknown>
    const author = stringValue(value<Record<string, unknown>>(item, "author")?.login, "unknown")
    const labels = Array.isArray(value(item, "labels"))
      ? value<unknown[]>(item, "labels")!
          .map((label) =>
            typeof label === "object" && label
              ? stringValue((label as Record<string, unknown>).name)
              : "",
          )
          .filter(Boolean)
          .join(", ")
      : "none"
    return [
      `#${number} ${String(value(item, "title") ?? "(untitled)")}`,
      `Author: ${author} · State: ${String(value(item, "state") ?? "unknown")}`,
      `Labels: ${labels}`,
      `URL: ${String(value(item, "url") ?? "")}`,
      "",
      String(value(item, "body") ?? "").trim() || "(no description)",
    ].join("\n")
  }

  async openPullRequest(number: number, cwd: string): Promise<void> {
    await this.checked(["pr", "view", String(number), "--web"], cwd, undefined, 30_000)
  }

  async openRepository(cwd: string): Promise<void> {
    await this.checked(["repo", "view", "--web"], cwd, undefined, 30_000)
  }

  async createPullRequest(
    title: string,
    body: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.checked(["pr", "create", "--title", title, "--body", body], cwd, signal, 120_000)
  }

  async editPullRequest(
    number: number,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.checked(["pr", "edit", String(number), ...args], cwd, signal, 60_000)
  }

  async commentOnPullRequest(
    number: number,
    body: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.checked(["pr", "comment", String(number), "--body", body], cwd, signal, 60_000)
  }

  async setPullRequestState(
    number: number,
    state: "close" | "reopen",
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.checked(["pr", state, String(number)], cwd, signal, 60_000)
  }

  async markReady(number: number, cwd: string, signal?: AbortSignal): Promise<string> {
    return this.checked(["pr", "ready", String(number)], cwd, signal, 60_000)
  }

  async mergePullRequest(
    number: number,
    method: "merge" | "squash" | "rebase",
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.checked(["pr", "merge", String(number), `--${method}`], cwd, signal, 120_000)
  }
}

export function formatPullRequest(pr: PullRequestSummary): string {
  const draft = pr.isDraft ? " · draft" : ""
  return `#${pr.number} ${pr.title} · ${pr.author} · ${pr.checks} checks · ${pr.reviewDecision}${draft}`
}

export function formatIssue(issue: IssueSummary): string {
  return `#${issue.number} ${issue.title} · ${issue.author}${issue.labels ? ` · ${issue.labels}` : ""}`
}
