import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Input, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "clickup_request";
const STATUS_KEY = "clickup-access";
const CLICKUP_ORIGIN = "https://api.clickup.com";
const CLICKUP_API = `${CLICKUP_ORIGIN}/api/v2`;
const KEYTAR_SERVICE = "pi-clickup-access";
const KEYTAR_ACCOUNT = "default";
const ALL_PERMISSIONS = ["r", "c", "u", "d"] as const;
type Permission = (typeof ALL_PERMISSIONS)[number];
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type ActiveRequest = {
  permission: Permission;
  controller: AbortController;
};

const RequestParams = Type.Object({
  method: StringEnum(["GET", "POST", "PUT", "PATCH", "DELETE"] as const),
  path: Type.String({
    description:
      "ClickUp API v2 path such as /team, /team/{team_id}/space, or /task/{task_id}. Full URLs are not required.",
  }),
  query: Type.Optional(
    Type.String({
      description: "Optional URL query string without the leading ?. Example: archived=true&page=0",
    }),
  ),
  body: Type.Optional(Type.Unknown({ description: "JSON request body for POST, PUT, or PATCH" })),
});

function permissionForMethod(method: string): Permission {
  switch (method.toUpperCase()) {
    case "GET":
      return "r";
    case "POST":
      return "c";
    case "PUT":
    case "PATCH":
      return "u";
    case "DELETE":
      return "d";
    default:
      throw new Error(`Unsupported HTTP method: ${method}`);
  }
}

function permissionText(permissions: ReadonlySet<Permission>): string {
  const value = ALL_PERMISSIONS.filter((permission) => permissions.has(permission)).join("");
  return value || "none";
}

function parsePermissions(raw: string, emptyMeansAll: boolean): Set<Permission> {
  const value = raw.trim().toLowerCase().replace(/[\s,+]/g, "");
  if (!value && emptyMeansAll) return new Set(ALL_PERMISSIONS);
  if (value === "all" || value === "*") return new Set(ALL_PERMISSIONS);
  if (!value || !/^[rcud]+$/.test(value)) {
    throw new Error("Permissions must be a combination of r, c, u, d, or all.");
  }
  return new Set(value.split("") as Permission[]);
}

function showPermissions(ctx: ExtensionContext, prefix: string): void {
  const permissions = currentPermissions();
  const text = `${prefix}\nCurrent ClickUp permissions: ${permissionText(permissions)}`;
  ctx.ui.setStatus(STATUS_KEY, `ClickUp: ${permissionText(permissions)}`);
  ctx.ui.notify(text, "info");
}

let permissions = new Set<Permission>();
let apiKey: string | undefined;
const activeRequests = new Set<ActiveRequest>();

function currentPermissions(): ReadonlySet<Permission> {
  return permissions;
}

function syncToolActivation(pi: ExtensionAPI): void {
  const active = pi.getActiveTools().filter((name) => name !== TOOL_NAME);
  if (permissions.size > 0) active.push(TOOL_NAME);
  pi.setActiveTools([...new Set(active)]);
}

function abortRequestsFor(revoked: ReadonlySet<Permission>): void {
  for (const request of activeRequests) {
    if (revoked.has(request.permission)) request.controller.abort();
  }
}

async function getKeytar(): Promise<{
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}> {
  const module = await import("keytar");
  return module;
}

async function loadStoredApiKey(): Promise<string | undefined> {
  const environmentKey = process.env.CLICKUP_API_KEY?.trim();
  if (environmentKey) return environmentKey;

  try {
    const stored = await (await getKeytar()).getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    return stored?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function saveApiKey(value: string): Promise<void> {
  try {
    await (await getKeytar()).setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, value);
  } catch {
    // The key remains available for this session. The next start will ask again
    // if the operating-system credential store is unavailable.
  }
}

async function promptForApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;

  if (ctx.mode !== "tui") {
    const value = await ctx.ui.input("ClickUp API key", "Paste your ClickUp personal/API token");
    return value?.trim() || undefined;
  }

  const value = await ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => {
      const input = new Input();
      const container = new Container();

      input.onSubmit = (submitted) => done(submitted.trim() || null);
      input.onEscape = () => done(null);

      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("ClickUp authentication")), 1, 0));
      container.addChild(new Text(theme.fg("muted", "Paste your ClickUp API key. It will not be shown or sent to the model."), 1, 0));
      container.addChild({
        render(width: number): string[] {
          const masked = "•".repeat([...input.getValue()].length);
          return [truncateToWidth(`  ${masked}${masked ? " " : "▏"}`, width, "")];
        },
        invalidate(): void {},
      });
      container.addChild(new Text(theme.fg("dim", "Enter to save • Escape to cancel"), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (width: number) => container.render(width),
        handleInput: (data: string) => {
          input.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => container.invalidate(),
      };
    },
    { overlay: true },
  );

  return value ?? undefined;
}

function resolveClickUpUrl(path: string, query?: string): URL {
  const candidate = path.trim();
  const url = candidate.startsWith("http://") || candidate.startsWith("https://")
    ? new URL(candidate)
    : new URL(candidate.startsWith("/api/v2") ? `${CLICKUP_ORIGIN}${candidate}` : `${CLICKUP_API}${candidate.startsWith("/") ? candidate : `/${candidate}`}`);

  if (url.origin !== CLICKUP_ORIGIN || !url.pathname.startsWith("/api/v2")) {
    throw new Error("ClickUp requests must target https://api.clickup.com/api/v2.");
  }

  if (query?.trim()) {
    const params = new URLSearchParams(query.replace(/^\?/, ""));
    for (const [key, value] of params) url.searchParams.set(key, value);
  }
  return url;
}

function truncateResponse(value: string): string {
  const lines = value.split("\n");
  const limited = lines.slice(0, 2000).join("\n");
  if (limited.length <= 50_000 && lines.length <= 2000) return limited;
  return `${limited.slice(0, 50_000)}\n\n[ClickUp response truncated]`;
}

export default function clickup(pi: ExtensionAPI): void {
  const reset = (): void => {
    permissions = new Set();
    apiKey = undefined;
    abortRequestsFor(new Set(ALL_PERMISSIONS));
    syncToolActivation(pi);
  };

  // Session access is deliberately ephemeral: every new/reloaded session starts locked.
  pi.on("session_start", (_event, ctx) => {
    reset();
    showPermissions(ctx, "ClickUp access is locked for this session.");
  });

  pi.on("session_shutdown", () => {
    reset();
  });

  pi.registerCommand("clickup-start", {
    description: "Grant ClickUp CRUD permissions. Empty means all permissions.",
    handler: async (args, ctx) => {
      try {
        const requested = parsePermissions(args, true);
        const credential = apiKey ?? (await loadStoredApiKey());

        if (!credential) {
          const entered = await promptForApiKey(ctx);
          if (!entered) throw new Error("ClickUp access was not started: no API key supplied.");
          await saveApiKey(entered);
          apiKey = entered;
        } else {
          apiKey = credential;
        }

        permissions = new Set([...permissions, ...requested]);
        syncToolActivation(pi);
        ctx.ui.notify(`ClickUp access started: granted ${permissionText(requested)}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        showPermissions(ctx, "ClickUp permission status:");
      }
    },
  });

  pi.registerCommand("clickup-stop", {
    description: "Revoke ClickUp CRUD permissions. Empty means all permissions. Does not require auth.",
    handler: async (args, ctx) => {
      try {
        const revoked = parsePermissions(args, true);
        abortRequestsFor(revoked);
        permissions = new Set([...permissions].filter((permission) => !revoked.has(permission)));
        if (permissions.size === 0) apiKey = undefined;
        syncToolActivation(pi);
        ctx.ui.notify(`ClickUp access stopped: revoked ${permissionText(revoked)}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        showPermissions(ctx, "ClickUp permission status:");
      }
    },
  });

  // This gate protects against stale model tool calls after clickup-stop.
  pi.on("tool_call", async (event) => {
    const toolEvent = event as { toolName?: string; input?: Record<string, unknown> };
    if (toolEvent.toolName !== TOOL_NAME) return;

    if (!apiKey || permissions.size === 0) {
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
    name: TOOL_NAME,
    label: "ClickUp Request",
    description:
      "Make an authenticated request to any ClickUp API v2 endpoint. This tool only appears after the user explicitly runs /clickup-start and each HTTP method is checked against the active CRUD permissions.",
    promptSnippet: "Use ClickUp API v2 with the currently granted CRUD permissions",
    parameters: RequestParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (!apiKey || permissions.size === 0) throw new Error("ClickUp access is stopped.");

      const method = params.method.toUpperCase() as HttpMethod;
      const permission = permissionForMethod(method);
      if (!permissions.has(permission)) {
        throw new Error(`ClickUp permission '${permission}' is not currently granted.`);
      }

      const url = resolveClickUpUrl(params.path, params.query);
      const controller = new AbortController();
      const request: ActiveRequest = { permission, controller };
      activeRequests.add(request);

      const abortFromParent = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", abortFromParent, { once: true });
      }

      try {
        const headers: Record<string, string> = {
          Accept: "application/json",
          Authorization: apiKey,
        };
        const hasBody = params.body !== undefined && method !== "GET" && method !== "DELETE";
        if (hasBody) headers["Content-Type"] = "application/json";

        const response = await fetch(url, {
          method,
          headers,
          body: hasBody ? JSON.stringify(params.body) : undefined,
          signal: controller.signal,
        });
        const text = truncateResponse(await response.text());
        if (!response.ok) throw new Error(`ClickUp API ${response.status} ${response.statusText}: ${text}`);

        return {
          content: [{ type: "text", text: text || `ClickUp request succeeded (${response.status}).` }],
          details: { status: response.status, method, path: url.pathname, permission },
        };
      } finally {
        if (signal) signal.removeEventListener("abort", abortFromParent);
        activeRequests.delete(request);
      }
    },
  });
}
