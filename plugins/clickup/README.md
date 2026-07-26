# ClickUp pi plugin

Command-gated ClickUp API access for pi. Access starts locked and is granted only through the `/clickup` settings menu.

## Menu

Open the UI with:

```text
/clickup
```

From the menu you can:

- grant selected CRUD permissions (authenticating only when needed)
- revoke selected permissions or stop all access immediately
- view the current access, permission, and credential state
- log out and delete the saved operating-system credential

Permissions are additive when granted and subtractive when revoked. `/clickup` never makes an API request itself; it only changes the permission gate used by the model's `clickup_request` tool.

## Authentication

When starting access without a saved credential, the plugin opens a masked prompt for a ClickUp personal/API token. The token is stored in the operating-system credential store through `keytar` and is never included in tool arguments or conversation messages.

Log out from `/clickup` to clear the in-memory token and delete the saved credential. If `CLICKUP_API_KEY` is set as an environment variable, it must be unset separately.

## CRUD permissions

The generic `clickup_request` tool can call any ClickUp API v2 endpoint, but every request is checked against the current permission set:

| Permission | HTTP methods   |
| ---------- | -------------- |
| `r`        | `GET`          |
| `c`        | `POST`         |
| `u`        | `PUT`, `PATCH` |
| `d`        | `DELETE`       |

The tool schema remains active for the session to preserve provider/tool-schema caching. Both the tool executor and the `tool_call` gate enforce the current permissions, so stopping access blocks stale calls too.

The tool schema stays stable for provider caching. Access and permission state is enforced by the tool-call gate and executor, without injecting access-state notices into the model context.

## Plugin development

This plugin is a workspace package. Its runtime and development dependencies use the repository catalog:

```bash
pnpm install
pnpm typecheck
```
