# pi host

`pi-host` is the server-side runtime for multiple independent pi sessions.

## run

```bash
pnpm server
```

configuration:

```text
PI_SERVER_HOST=127.0.0.1
PI_SERVER_PORT=3333
PI_SERVER_EVENT_HISTORY=1000
PI_AGENT_DIR=~/.pi/agent
PI_SERVER_AUTH_TOKEN=optional-bearer-token
PI_SERVER_PUBLIC_URL=http://127.0.0.1:3333
```

`PI_SERVER_AUTH_TOKEN` should be set before exposing the server through
Tailscale. The health and OpenAPI discovery endpoints remain public on the
local listener.

## OpenAPI

- interactive documentation: `http://127.0.0.1:3333/openapi`
- OpenAPI JSON: `http://127.0.0.1:3333/openapi/json`

The request schemas are defined in `server/src/app.ts`. This document is the
contract that future mobile clients should use for generated clients and
receivers.

## current endpoints

```text
GET    /v1/health
GET    /v1/sessions
POST   /v1/sessions
GET    /v1/sessions/:id
DELETE /v1/sessions/:id
POST   /v1/sessions/:id/prompt
POST   /v1/sessions/:id/bash
POST   /v1/sessions/:id/abort
GET    /v1/sessions/:id/events
```

`POST /v1/sessions/:id/bash` uses pi's `AgentSession.executeBash()` directly.
It does not create an agent turn. By default, the result is persisted and
included in the session context. Set `excludeFromContext` to `true` for the
`!!` behavior.

Events are delivered as server-sent events. Each event has a monotonic server
sequence, session id, event type, timestamp, and payload. Reconnect with the
`since` query parameter.
