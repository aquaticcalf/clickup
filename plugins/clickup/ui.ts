import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
  Container,
  SettingsList,
  Spacer,
  Text,
  matchesKey,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui"
import { ALL_PERMISSIONS } from "./constants.ts"
import { permissionText } from "./permissions.ts"
import type { Permission } from "./types.ts"

export interface ClickUpMenuActions {
  currentPermissions(): ReadonlySet<Permission>
  start(permissions: ReadonlySet<Permission>): Promise<string>
  revoke(permissions: ReadonlySet<Permission>): Promise<string>
  stop(): Promise<string>
  logout(): Promise<string>
  status(): string
}

interface MenuContext {
  ctx: ExtensionContext
  actions: ClickUpMenuActions
  tui: { requestRender(): void }
  done: () => void
}

let currentTheme: ExtensionContext["ui"]["theme"]

function border(): DynamicBorder {
  return new DynamicBorder((text: string) => currentTheme.fg("accent", text))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class SettingsPanel extends Container {
  private readonly list: SettingsList
  private readonly title: string
  private readonly description: string

  constructor(
    title: string,
    description: string,
    items: SettingItem[],
    onChange: (id: string, value: string) => void,
    onCancel: () => void,
  ) {
    super()
    this.title = title
    this.description = description
    this.list = new SettingsList(
      items,
      Math.min(Math.max(items.length, 8), 15),
      getSettingsListTheme(),
      onChange,
      onCancel,
      {
        enableSearch: true,
      },
    )
    this.addChild(this.list)
  }

  private submenuIsOpen(): boolean {
    return Boolean((this.list as unknown as { submenuComponent?: Component }).submenuComponent)
  }

  override render(width: number): string[] {
    const lines: string[] = []
    if (!this.submenuIsOpen()) {
      lines.push(...border().render(width))
      lines.push(
        ...new Text(currentTheme.bold(currentTheme.fg("accent", this.title)), 0, 0).render(width),
      )
      if (this.description) {
        lines.push("")
        lines.push(...new Text(currentTheme.fg("muted", this.description), 0, 0).render(width))
      }
      lines.push("")
    }

    lines.push(...this.list.render(width))
    if (!this.submenuIsOpen()) lines.push(...border().render(width))
    return lines
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
  }
}

class MessagePanel extends Container {
  constructor(title: string, body: string, onCancel: () => void, error = false) {
    super()
    this.addChild(border())
    this.addChild(new Text(currentTheme.bold(currentTheme.fg("accent", title)), 0, 0))
    this.addChild(new Spacer(1))
    this.addChild(new Text(error ? currentTheme.fg("error", body) : body, 0, 0))
    this.addChild(new Spacer(1))
    this.addChild(new Text(currentTheme.fg("dim", "  Esc to go back"), 0, 0))
    this.addChild(border())
    this.onCancel = onCancel
  }

  private readonly onCancel: () => void

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.onCancel()
  }
}

class ActionPanel extends Container {
  private active: MessagePanel

  constructor(
    title: string,
    description: string,
    operation: () => Promise<string>,
    onCancel: () => void,
    requestRender: () => void,
  ) {
    super()
    this.active = new MessagePanel(title, `${description}\n\nWorking…`, onCancel)
    this.addChild(this.active)
    void operation()
      .then((result) => {
        this.active = new MessagePanel(title, `${description}\n\n${result}`, onCancel)
        this.clear()
        this.addChild(this.active)
        requestRender()
      })
      .catch((error: unknown) => {
        this.active = new MessagePanel(
          title,
          `${description}\n\n${errorText(error)}`,
          onCancel,
          true,
        )
        this.clear()
        this.addChild(this.active)
        requestRender()
      })
  }

  handleInput(data: string): void {
    this.active.handleInput(data)
  }
}

function actionPanel(
  menu: MenuContext,
  title: string,
  description: string,
  operation: () => Promise<string>,
): Component {
  return new ActionPanel(title, description, operation, menu.done, () => menu.tui.requestRender())
}

function permissionPicker(menu: MenuContext, mode: "grant" | "revoke"): Component {
  const selected = new Set(menu.actions.currentPermissions())
  if (mode === "grant" && selected.size === 0) {
    for (const permission of ALL_PERMISSIONS) selected.add(permission)
  }

  const label = mode === "grant" ? "Grant permissions" : "Revoke permissions"
  const items: SettingItem[] = ALL_PERMISSIONS.map((permission) => ({
    id: permission,
    label:
      permission === "r"
        ? "Read"
        : permission === "c"
          ? "Create"
          : permission === "u"
            ? "Update"
            : "Delete",
    description:
      permission === "r"
        ? "GET requests"
        : permission === "c"
          ? "POST requests"
          : permission === "u"
            ? "PUT and PATCH requests"
            : "DELETE requests",
    currentValue: selected.has(permission) ? "yes" : "no",
    values: ["no", "yes"],
  }))
  items.push({
    id: "apply",
    label: mode === "grant" ? "Grant selected" : "Revoke selected",
    description: "Apply this permission selection.",
    currentValue: "continue",
    submenu: () =>
      actionPanel(
        menu,
        label,
        `${mode === "grant" ? "Grant" : "Revoke"} ${permissionText(selected)} permission(s).`,
        () => (mode === "grant" ? menu.actions.start(selected) : menu.actions.revoke(selected)),
      ),
  })

  return new SettingsPanel(
    label,
    "Toggle permissions, then apply the selection.",
    items,
    (id, value) => {
      if (id === "apply") return
      const permission = id as Permission
      if (value === "yes") selected.add(permission)
      else selected.delete(permission)
    },
    menu.done,
  )
}

function makeAccess(menu: MenuContext): Component {
  const current = permissionText(menu.actions.currentPermissions())
  return new SettingsPanel(
    "Access",
    "Start, narrow, or stop ClickUp access for this session.",
    [
      {
        id: "permissions",
        label: "Current permissions",
        description: "The CRUD permissions currently granted to the model.",
        currentValue: current,
      },
      {
        id: "grant",
        label: "Grant permissions",
        description: "Add selected CRUD permissions and authenticate if needed.",
        currentValue: "choose",
        submenu: () => permissionPicker(menu, "grant"),
      },
      {
        id: "revoke",
        label: "Revoke permissions",
        description: "Remove selected permissions and abort matching requests.",
        currentValue: "choose",
        submenu: () => permissionPicker(menu, "revoke"),
      },
      {
        id: "stop",
        label: "Stop all access",
        description: "Revoke every permission and clear the in-memory credential.",
        currentValue: "stop",
        submenu: () =>
          actionPanel(menu, "Stop ClickUp access", "Revoke all permissions immediately.", () =>
            menu.actions.stop(),
          ),
      },
    ],
    () => undefined,
    menu.done,
  )
}

export function createClickUpMenu(
  ctx: ExtensionContext,
  actions: ClickUpMenuActions,
  tui: { requestRender(): void },
  done: () => void,
): Component {
  currentTheme = ctx.ui.theme
  const menu: MenuContext = { ctx, actions, tui, done }
  return new SettingsPanel(
    "ClickUp",
    "Manage access without separate start, stop, and logout commands.",
    [
      {
        id: "access",
        label: "Access and permissions",
        description: "Grant, revoke, or stop CRUD access.",
        currentValue: permissionText(actions.currentPermissions()),
        submenu: (_value, back) => makeAccess({ ...menu, done: back }),
      },
      {
        id: "status",
        label: "Status",
        description: "Show the current credential and permission state.",
        currentValue: "view",
        submenu: () =>
          actionPanel(menu, "ClickUp status", "Current local access state.", async () =>
            actions.status(),
          ),
      },
      {
        id: "logout",
        label: "Log out",
        description: "Stop access and delete the saved operating-system credential.",
        currentValue: "logout",
        submenu: () =>
          actionPanel(menu, "ClickUp logout", "Delete the saved credential and stop access.", () =>
            menu.actions.logout(),
          ),
      },
    ],
    () => undefined,
    done,
  )
}
