import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLICKUP_TOOL_NAME } from "./constants.ts";
import { CredentialStore } from "./auth/credential-store.ts";
import { promptForApiKey } from "./auth/prompt.ts";
import { ClickUpClient } from "./api/client.ts";
import { RequestParams } from "./api-schema.ts";
import { PermissionManager, parsePermissions, permissionForMethod, permissionText } from "./permissions.ts";
import { reportPermissions } from "./ui/permissions.ts";

export default function clickup(pi: ExtensionAPI): void {
  const permissions = new PermissionManager();
  const credentials = new CredentialStore();
  let apiKey: string | undefined;
  const client = new ClickUpClient(() => apiKey, permissions);

  const syncToolActivation = (): void => {
    const active = pi.getActiveTools().filter((name) => name !== CLICKUP_TOOL_NAME);
    if (permissions.hasAny) active.push(CLICKUP_TOOL_NAME);
    pi.setActiveTools([...new Set(active)]);
  };

  const reset = (): void => {
    permissions.reset();
    apiKey = undefined;
    syncToolActivation();
  };

  // Access is intentionally ephemeral: new and reloaded sessions start locked.
  pi.on("session_start", (_event, ctx) => {
    reset();
    reportPermissions(ctx, permissions, "ClickUp access is locked for this session.");
  });

  pi.on("session_shutdown", reset);

  pi.registerCommand("clickup-start", {
    description: "Grant ClickUp CRUD permissions. Empty means all permissions.",
    handler: async (args, ctx) => {
      try {
        const requested = parsePermissions(args, true);
        const credential = apiKey ?? (await credentials.load());

        if (!credential) {
          const entered = await promptForApiKey(ctx);
          if (!entered) throw new Error("ClickUp access was not started: no API key supplied.");
          await credentials.save(entered);
          apiKey = entered;
        } else {
          apiKey = credential;
        }

        permissions.grant(requested);
        syncToolActivation();
        ctx.ui.notify(`ClickUp access started: granted ${permissionText(requested)}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        reportPermissions(ctx, permissions, "ClickUp permission status:");
      }
    },
  });

  pi.registerCommand("clickup-stop", {
    description: "Revoke ClickUp CRUD permissions. Empty means all permissions. Does not require auth.",
    handler: async (args, ctx) => {
      try {
        const revoked = parsePermissions(args, true);
        permissions.revoke(revoked);
        if (!permissions.hasAny) apiKey = undefined;
        syncToolActivation();
        ctx.ui.notify(`ClickUp access stopped: revoked ${permissionText(revoked)}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        reportPermissions(ctx, permissions, "ClickUp permission status:");
      }
    },
  });

  // Protects against stale model calls after clickup-stop.
  pi.on("tool_call", async (event) => {
    const toolEvent = event as { toolName?: string; input?: Record<string, unknown> };
    if (toolEvent.toolName !== CLICKUP_TOOL_NAME) return;

    if (!apiKey || !permissions.hasAny) {
      return { block: true, reason: "ClickUp access is currently stopped." };
    }

    try {
      const permission = permissionForMethod(String(toolEvent.input?.method ?? ""));
      if (!permissions.has(permission)) {
        return { block: true, reason: `ClickUp permission '${permission}' is not currently granted.` };
      }
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  pi.registerTool({
    name: CLICKUP_TOOL_NAME,
    label: "ClickUp Request",
    description:
      "Make an authenticated request to any ClickUp API v2 endpoint. This tool only appears after the user explicitly runs /clickup-start and each HTTP method is checked against active CRUD permissions.",
    promptSnippet: "Use ClickUp API v2 with the currently granted CRUD permissions",
    parameters: RequestParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      return client.request(params, signal);
    },
  });
}
