# pi server plugin

Controls the background `pi-host` daemon from the Pi command palette.

```text
/server start
/server stop
/server status
/server logout
```

`/server start` creates a new cryptographically strong bearer token, stores it
under the `pi-host-auth` service in the operating-system credential store, and
shows a QR pairing payload in the TUI. The token is passed to the detached
server process through its environment. The token is never written to the
pid/state file or displayed as text in status output.

Set `PI_SERVER_PUBLIC_URL` when the address visible to the mobile device is
different from the local listener. The QR payload contains that URL and the
new token as a versioned JSON pairing record.

The daemon state is tracked at:

```text
~/.pi/agent/pi-host.json
```

The plugin uses the repository's `server/src/index.ts` entrypoint. It is
intended to keep the daemon alive when the interactive Pi session exits.
