import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLICKUP_STATUS_KEY } from "../constants.ts";
import { PermissionManager, permissionText } from "../permissions.ts";

export function reportPermissions(ctx: ExtensionContext, manager: PermissionManager, prefix: string): void {
  const current = permissionText(manager.current);
  ctx.ui.setStatus(CLICKUP_STATUS_KEY, `ClickUp: ${current}`);
  ctx.ui.notify(`${prefix}\nCurrent ClickUp permissions: ${current}`, "info");
}

/**
 * Add the state as a normal conversation message rather than changing the system
 * prompt. This keeps the stable system/tool prefix cacheable while making the
 * latest permission state available to the model on its next turn.
 */
export function publishPermissionsToModel(pi: ExtensionAPI, manager: PermissionManager): void {
  const current = permissionText(manager.current);
  const enabled = current !== "none";
  const guidance = enabled
    ? "The clickup_request tool is available, but every request must stay within these permissions."
    : "Do not call clickup_request or claim ClickUp access until the user explicitly starts access.";

  pi.sendMessage(
    {
      customType: "clickup-access-state",
      content: [
        "Authoritative ClickUp access state from the extension (latest state supersedes older state messages):",
        `Status: ${enabled ? "ACTIVE" : "STOPPED"}`,
        `CRUD permissions: ${current}`,
        guidance,
      ].join("\n"),
      display: false,
      details: { permissions: current, active: enabled },
    },
    { deliverAs: "nextTurn" },
  );
}
