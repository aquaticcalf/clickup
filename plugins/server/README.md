# pi server plugin

controls the background `pi-host` daemon from the pi command palette.

```text
/server start
/server enable
/server stop
/server status
/server logout
```

`/server start` starts the daemon detached from the interactive pi process.
`/server enable` additionally registers a per-user startup service and starts
it automatically after login. the service is kept alive by the platform
supervisor and uses the saved credential-store token, so device restarts do
not require a new qr pairing.

startup registration uses:

- windows per-user startup registration
- macos launch agent
- linux systemd user service

`/server stop` stops the daemon and removes the startup registration. use
`/server enable` again to restore automatic startup. `pnpm server` remains a
foreground development command and is not registered automatically.

`/server start` creates a cryptographically strong bearer token on first use
and stores it under the `pi-host-auth` service in the operating-system
credential store. the token is never written to the pid/state file or shown in
status output.

set `PI_SERVER_PUBLIC_URL` when the address visible to the mobile device is
different from the local listener. the qr payload contains that url and the
versioned pairing record.

the daemon state is tracked at:

```text
~/.pi/agent/pi-host.json
```

active sessions and event history are still held in memory by the server. use
persisted session files and `sessionFile` to reopen sessions after a reboot.
