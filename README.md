# pi-clickup-access

A command-gated ClickUp extension for pi. ClickUp access is disabled when a session starts and is granted only by explicit user commands.

## Commands

```text
/clickup-start       # grant all CRUD permissions
/clickup-start r     # grant read permission
/clickup-start rc    # grant read and create permissions
/clickup-stop        # revoke all permissions
/clickup-stop u      # revoke update permission only
```

Permissions are additive on start and subtractive on stop. Every start/stop command prints the current permissions. `/clickup-stop` is an emergency local kill switch and never requires authentication.

When starting access without a saved credential, the extension opens a masked popup for a ClickUp API/personal token. Credentials are stored with `keytar` in the operating system credential store and are never included in tool arguments or session messages.

## Install

From this package directory:

```bash
npm install
pi install .
```

Or try it without installing:

```bash
pi -e ./extensions/clickup.ts
```

After installation, restart pi or run `/reload`.

## Notes

The extension exposes a generic `clickup_request` tool only while at least one permission is active. CRUD permissions map to HTTP methods: `r` = GET, `c` = POST, `u` = PUT/PATCH, and `d` = DELETE. The token itself may have broad ClickUp API capabilities; the extension enforces the runtime permission boundary.
