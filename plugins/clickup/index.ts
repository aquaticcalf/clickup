import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { createClickUpMenu, type ClickUpMenuActions } from "./ui.ts"
import { CLICKUP_STATUS_KEY, CLICKUP_TOOL_NAME } from "./constants.ts"
import { CredentialStore } from "./auth/credential-store.ts"
import { promptForApiKey } from "./auth/prompt.ts"
import { ClickUpClient } from "./api/client.ts"
import { RequestParams } from "./api-schema.ts"
import { PermissionManager, permissionForMethod, permissionText } from "./permissions.ts"

export default function clickup(pi: ExtensionAPI): void {
  const permissions = new PermissionManager()
  const credentials = new CredentialStore()
  let apiKey: string | undefined
  const client = new ClickUpClient(() => apiKey, permissions)

  // Keep the tool schema active for the whole session. The permission gate is
  // the security boundary; keeping the schema stable preserves provider caches.
  const ensureToolActive = (): void => {
    const active = pi.getActiveTools()
    if (!active.includes(CLICKUP_TOOL_NAME)) pi.setActiveTools([...active, CLICKUP_TOOL_NAME])
  }

  const reset = (): void => {
    permissions.reset()
    apiKey = undefined
  }

  const syncState = (ctx: ExtensionCommandContext): void => {
    const current = permissionText(permissions.current)
    ctx.ui.setStatus(CLICKUP_STATUS_KEY, current === "none" ? undefined : `ClickUp: ${current}`)
  }

  const actions = (ctx: ExtensionCommandContext): ClickUpMenuActions => ({
    currentPermissions: () => permissions.current,
    start: async (requested) => {
      if (requested.size === 0)
        throw new Error("Select at least one permission before starting access.")
      const credential = apiKey ?? (await credentials.load())
      if (!credential) {
        const entered = await promptForApiKey(ctx)
        if (!entered) throw new Error("ClickUp access was not started: no API key supplied.")
        await credentials.save(entered)
        apiKey = entered
      } else {
        apiKey = credential
      }
      permissions.grant(requested)
      syncState(ctx)
      return `Granted ${permissionText(requested)}. Current permissions: ${permissionText(permissions.current)}.`
    },
    revoke: async (requested) => {
      permissions.revoke(requested)
      if (!permissions.hasAny) apiKey = undefined
      syncState(ctx)
      return `Revoked ${permissionText(requested)}. Current permissions: ${permissionText(permissions.current)}.`
    },
    stop: async () => {
      const previous = permissionText(permissions.current)
      permissions.reset()
      apiKey = undefined
      syncState(ctx)
      return `ClickUp access stopped. Revoked ${previous}.`
    },
    logout: async () => {
      permissions.reset()
      apiKey = undefined
      const deleted = await credentials.delete()
      const environmentCredential = credentials.hasEnvironmentCredential()
      const storageMessage = deleted
        ? "The saved operating-system credential was deleted."
        : "No saved operating-system credential was deleted."
      const environmentMessage = environmentCredential
        ? " CLICKUP_API_KEY is still set externally and must be unset separately."
        : ""
      syncState(ctx)
      return `ClickUp logged out. ${storageMessage}${environmentMessage}`
    },
    status: () => {
      const current = permissionText(permissions.current)
      const credential = apiKey
        ? "loaded for this session"
        : credentials.hasEnvironmentCredential()
          ? "provided by CLICKUP_API_KEY"
          : "not loaded"
      return [
        `Access: ${current === "none" ? "STOPPED" : "ACTIVE"}`,
        `CRUD permissions: ${current}`,
        `Credential: ${credential}`,
      ].join("\\n")
    },
  })

  // Access is intentionally ephemeral: new and reloaded sessions start locked.
  pi.on("session_start", (_event, ctx) => {
    reset()
    ensureToolActive()
    syncState(ctx as ExtensionCommandContext)
  })

  pi.on("session_shutdown", (_event, ctx) => {
    reset()
    ctx.ui.setStatus(CLICKUP_STATUS_KEY, undefined)
  })

  pi.registerCommand("clickup", {
    description: "Open the ClickUp access and permissions menu",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/clickup requires TUI mode.", "error")
        return
      }
      await ctx.ui.custom<void>((tui, _theme, _keybindings, done) =>
        createClickUpMenu(ctx, actions(ctx), tui, done),
      )
    },
  })

  // Protects against stale model calls after access is stopped in the menu.
  pi.on("tool_call", async (event) => {
    const toolEvent = event as { toolName?: string; input?: Record<string, unknown> }
    if (toolEvent.toolName !== CLICKUP_TOOL_NAME) return

    if (!apiKey || !permissions.hasAny) {
      return { block: true, reason: "ClickUp access is currently stopped." }
    }

    try {
      const method = toolEvent.input?.method
      const permission = permissionForMethod(typeof method === "string" ? method : "")
      if (!permissions.has(permission)) {
        return {
          block: true,
          reason: `ClickUp permission '${permission}' is not currently granted.`,
        }
      }
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) }
    }
  })

  pi.registerTool({
    name: CLICKUP_TOOL_NAME,
    label: "ClickUp Request",
    description: "Make an authenticated request to any ClickUp API v2 endpoint.",
    promptSnippet: "Use the ClickUp API v2 request tool when needed.",
    parameters: RequestParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      return client.request(params, signal)
    },
  })
}
