# pi-clickup-access

A command-gated ClickUp extension for pi. ClickUp access is disabled when a session starts and is granted only by explicit user commands.

## Commands

```text
/clickup-start       # grant all CRUD permissions
/clickup-start r     # grant read permission
/clickup-start rc    # grant read and create permissions
/clickup-stop        # revoke all permissions
/clickup-stop u      # revoke update permission only
/clickup-logout       # revoke all access and delete the saved credential
```

Permissions are additive on start and subtractive on stop. Every access command prints the current permissions. `/clickup-stop` is an emergency local kill switch and never requires authentication.

When starting access without a saved credential, the extension opens a masked popup for a ClickUp API/personal token. Credentials are stored with `keytar` in the operating system credential store and are never included in tool arguments or session messages.

## Try without cloning or permanently installing

Run the published GitHub package for one pi session:

```bash
pi -e git:github.com/aquaticcalf/clickup@master
```

This uses pi's temporary extension loading. It does not add the package to your pi settings.

When pi starts, try:

```text
/clickup-start
```

The empty command grants all permissions and opens the API-key popup if needed. Then use `/clickup-stop` to revoke everything. Use `/clickup-logout` to revoke access and delete the saved credential.

## Install permanently

From GitHub:

```bash
pi install git:github.com/aquaticcalf/clickup@master
```

From a local checkout:

```bash
npm install
pi install .
```

For a local one-session test from an existing checkout:

```bash
pi -e .
# or
pi -e ./plugins/clickup/index.ts
```

After a permanent install, restart pi or run `/reload`.

## pnpm workspace development

This repository is a pnpm workspace using a shared catalog for Pi SDK packages and runtime/dev dependencies:

```bash
pnpm install
pnpm typecheck
```

Pi uses npm by default when installing Git packages. To make Pi use this workspace's pnpm setup, add this to `~/.pi/agent/settings.json`:

```json
{
  "npmCommand": ["pnpm"]
}
```

A new terminal may be needed after installing pnpm so `pnpm` is on `PATH`. The workspace allows the `keytar` native build and keeps other dependency build scripts disabled.

## Selective plugin loading

This repository is a collection of independently loadable plugins. The root package discovers plugin entrypoints with `./plugins/*/index.ts`.

To load only selected plugins from a package installation, use a filtered package entry in pi settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/aquaticcalf/clickup@master",
      "extensions": ["plugins/clickup/index.ts"]
    }
  ]
}
```

You can also use `pi config` to enable or disable individual extensions.

## Structure

```text
plugins/
└── clickup/
    ├── index.ts                 # pi registration and lifecycle orchestration
    ├── permissions.ts           # CRUD parsing, state, and request cancellation
    ├── api-schema.ts            # ClickUp tool schema
    ├── api/client.ts            # URL validation and HTTP transport
    ├── auth/credential-store.ts # OS credential-store integration
    ├── auth/prompt.ts           # masked TUI credential prompt
    ├── ui/permissions.ts        # status and permission notifications
    ├── constants.ts
    └── types.ts
```

## Notes

The extension exposes a generic `clickup_request` tool throughout the session for stable provider/tool-schema caching. It is unusable while stopped: both the tool executor and `tool_call` gate enforce the current permission state.

`/clickup-logout` additionally clears the in-memory key and deletes the saved operating-system credential. If `CLICKUP_API_KEY` is set externally, that environment credential must be unset separately.

After every access change, the extension adds a hidden, non-system conversation message containing the authoritative current state. This lets the model know whether ClickUp is active without changing the system prompt or repeatedly invalidating its stable cache prefix.

CRUD permissions map to HTTP methods: `r` = GET, `c` = POST, `u` = PUT/PATCH, and `d` = DELETE. The token itself may have broad ClickUp API capabilities; the extension enforces the runtime permission boundary.
