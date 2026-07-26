# ClickUp pi plugin

Command-gated ClickUp API access for pi. Access starts locked and is granted only through explicit user commands.

## Commands

```text
/clickup-start         # grant all CRUD permissions
/clickup-start r       # grant read permission
/clickup-start rc      # grant read and create permissions
/clickup-start rcu     # grant read, create, and update permissions
/clickup-stop          # revoke all permissions
/clickup-stop u        # revoke update permission only
/clickup-logout        # revoke access and delete the saved credential
```

Permissions are additive on start and subtractive on stop. Every access command prints the current permissions. `/clickup-stop` and `/clickup-logout` never require authentication and act as local emergency controls.

## Authentication

When starting access without a saved credential, the plugin opens a masked popup for a ClickUp personal/API token. The token is stored in the operating-system credential store through `keytar` and is never included in tool arguments or conversation messages.

`/clickup-logout` clears the in-memory token and deletes the saved credential. If `CLICKUP_API_KEY` is set as an environment variable, it must be unset separately.

## CRUD permissions

The generic `clickup_request` tool can call any ClickUp API v2 endpoint, but every request is checked against the current permission set:

| Permission | HTTP methods |
|---|---|
| `r` | `GET` |
| `c` | `POST` |
| `u` | `PUT`, `PATCH` |
| `d` | `DELETE` |

The tool schema remains active for the session to preserve provider/tool-schema caching. Both the tool executor and the `tool_call` gate enforce the current permissions, so stopping access blocks stale calls too.

After every access change, a hidden non-system conversation message tells the model the authoritative current state. This avoids changing the system prompt or repeatedly invalidating its stable cache prefix.

## Plugin development

This plugin is a workspace package. Its runtime and development dependencies use the repository catalog:

```bash
pnpm install
pnpm typecheck
```
