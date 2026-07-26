import {
  CLICKUP_API_BASE,
  CLICKUP_ORIGIN,
  MAX_RESPONSE_BYTES,
  MAX_RESPONSE_LINES,
} from "../constants.ts"
import { PermissionManager } from "../permissions.ts"
import type { ClickUpRequestParams } from "../types.ts"

function resolveClickUpUrl(path: string, query?: string): URL {
  const candidate = path.trim()
  const url =
    candidate.startsWith("http://") || candidate.startsWith("https://")
      ? new URL(candidate)
      : new URL(
          candidate.startsWith("/api/v2")
            ? `${CLICKUP_ORIGIN}${candidate}`
            : `${CLICKUP_API_BASE}${candidate.startsWith("/") ? candidate : `/${candidate}`}`,
        )

  if (url.origin !== CLICKUP_ORIGIN || !url.pathname.startsWith("/api/v2")) {
    throw new Error("ClickUp requests must target https://api.clickup.com/api/v2.")
  }

  if (query?.trim()) {
    const params = new URLSearchParams(query.replace(/^\?/, ""))
    for (const [key, value] of params) url.searchParams.set(key, value)
  }
  return url
}

function truncateResponse(value: string): string {
  const lines = value.split("\n")
  const limited = lines.slice(0, MAX_RESPONSE_LINES).join("\n")
  if (limited.length <= MAX_RESPONSE_BYTES && lines.length <= MAX_RESPONSE_LINES) return limited
  return `${limited.slice(0, MAX_RESPONSE_BYTES)}\n\n[ClickUp response truncated]`
}

export class ClickUpClient {
  constructor(
    private readonly getApiKey: () => string | undefined,
    private readonly permissions: PermissionManager,
  ) {}

  async request(params: ClickUpRequestParams, parentSignal?: AbortSignal) {
    const apiKey = this.getApiKey()
    if (!apiKey || !this.permissions.hasAny) throw new Error("ClickUp access is stopped.")

    const permission = this.permissions.require(params.method)
    const url = resolveClickUpUrl(params.path, params.query)
    const controller = new AbortController()
    const request = this.permissions.registerRequest(permission, controller)
    const abortFromParent = () => controller.abort()

    if (parentSignal) {
      if (parentSignal.aborted) controller.abort()
      else parentSignal.addEventListener("abort", abortFromParent, { once: true })
    }

    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: apiKey,
      }
      const hasBody =
        params.body !== undefined && params.method !== "GET" && params.method !== "DELETE"
      if (hasBody) headers["Content-Type"] = "application/json"

      const response = await fetch(url, {
        method: params.method,
        headers,
        body: hasBody ? JSON.stringify(params.body) : undefined,
        signal: controller.signal,
      })
      const text = truncateResponse(await response.text())
      if (!response.ok)
        throw new Error(`ClickUp API ${response.status} ${response.statusText}: ${text}`)

      return {
        content: [
          {
            type: "text" as const,
            text: text || `ClickUp request succeeded (${response.status}).`,
          },
        ],
        details: { status: response.status, method: params.method, path: url.pathname, permission },
      }
    } finally {
      if (parentSignal) parentSignal.removeEventListener("abort", abortFromParent)
      this.permissions.unregisterRequest(request)
    }
  }
}
