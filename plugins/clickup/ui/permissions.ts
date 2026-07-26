import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { CLICKUP_STATUS_KEY } from "../constants.ts"
import { PermissionManager, permissionText } from "../permissions.ts"

export function reportPermissions(
  ctx: ExtensionContext,
  manager: PermissionManager,
  prefix: string,
): void {
  const current = permissionText(manager.current)
  if (current === "none") ctx.ui.setStatus(CLICKUP_STATUS_KEY, undefined)
  else ctx.ui.setStatus(CLICKUP_STATUS_KEY, `ClickUp: ${current}`)
  ctx.ui.notify(`${prefix}\nCurrent ClickUp permissions: ${current}`, "info")
}
