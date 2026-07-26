import { Elysia, status, t } from "elysia"
import { openapi } from "@elysiajs/openapi"
import { EventHub } from "./events.ts"
import { SessionRegistry } from "./sessions.ts"
import type { ServerConfig, ServerEvent } from "./types.ts"

const ErrorResponse = t.Object({
  error: t.String(),
})

const SessionStatus = t.Object({
  id: t.String(),
  cwd: t.String(),
  createdAt: t.String(),
  sessionFile: t.Optional(t.String()),
  sessionName: t.Optional(t.String()),
  isStreaming: t.Boolean(),
  isIdle: t.Boolean(),
  isBashRunning: t.Boolean(),
  model: t.Optional(t.Object({ provider: t.String(), id: t.String() })),
  thinkingLevel: t.String(),
  activeTools: t.Array(t.String()),
})

const CreateSessionBody = t.Object({
  cwd: t.Optional(t.String()),
  sessionFile: t.Optional(t.String()),
})

const PromptBody = t.Object({
  text: t.String({ minLength: 1 }),
})

const BashBody = t.Object({
  command: t.String({ minLength: 1 }),
  excludeFromContext: t.Optional(t.Boolean()),
})

function jsonError(message: string) {
  return { error: message }
}

function formatSse(event: ServerEvent): string {
  return [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n")
}

function eventStream(
  request: Request,
  events: EventHub,
  sessionId: string,
  since: number,
): Response {
  let cancelStream = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let unsubscribe = () => {}

      const close = () => {
        if (closed) return
        closed = true
        unsubscribe()
        if (heartbeat) clearInterval(heartbeat)
        request.signal.removeEventListener("abort", close)
        try {
          controller.close()
        } catch {
          // the client may have disconnected before the stream was closed
        }
      }

      const push = (event: ServerEvent) => {
        if (!closed) controller.enqueue(encoder.encode(formatSse(event)))
      }

      cancelStream = close
      unsubscribe = events.subscribe(sessionId, push)
      for (const event of events.since(sessionId, since)) push(event)
      controller.enqueue(encoder.encode(": connected\n\n"))
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"))
      }, 15_000)
      request.signal.addEventListener("abort", close, { once: true })
    },
    cancel() {
      // native http disconnects trigger request.signal. fetch callers can cancel
      // the body directly, in which case the request signal may not fire.
      cancelStream()
    },
  })

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    },
  })
}

export function createApp(config: ServerConfig) {
  const events = new EventHub(config.eventHistorySize)
  const sessions = new SessionRegistry(config, events)

  const app = new Elysia({ name: "pi-host" })
    .use(
      openapi({
        documentation: {
          info: {
            title: "pi host api",
            version: "0.1.0",
            description: "server-side control and event streaming for pi sessions",
          },
          tags: [
            { name: "system", description: "server health" },
            { name: "sessions", description: "pi agent sessions" },
            { name: "events", description: "session event streams" },
          ],
          security: [{ bearerAuth: [] }],
          components: {
            securitySchemes: {
              bearerAuth: {
                type: "http",
                scheme: "bearer",
              },
            },
          },
        },
      }),
    )
    .onBeforeHandle(({ request, set, path }) => {
      if (!config.authToken || path === "/v1/health" || path.startsWith("/openapi")) return
      const authorization = request.headers.get("authorization")
      if (authorization !== `Bearer ${config.authToken}`) {
        set.status = 401
        return jsonError("authentication required")
      }
    })
    .get("/v1/health", () => ({ ok: true, service: "pi-host" }), {
      detail: { tags: ["system"] },
      response: t.Object({ ok: t.Boolean(), service: t.String() }),
    })
    .get(
      "/v1/sessions",
      () => ({ sessions: sessions.list().map((session) => sessions.status(session)) }),
      {
        detail: { tags: ["sessions"] },
        response: t.Object({ sessions: t.Array(SessionStatus) }),
      },
    )
    .post(
      "/v1/sessions",
      async ({ body }) => {
        try {
          const session = await sessions.create(body)
          return sessions.status(session)
        } catch (error) {
          return status(400, jsonError(error instanceof Error ? error.message : String(error)))
        }
      },
      {
        body: CreateSessionBody,
        detail: { tags: ["sessions"] },
        response: { 200: SessionStatus, 400: ErrorResponse },
      },
    )
    .get(
      "/v1/sessions/:id",
      ({ params }) => {
        const session = sessions.get(params.id)
        if (!session) return status(404, jsonError("session not found"))
        return sessions.status(session)
      },
      {
        params: t.Object({ id: t.String() }),
        detail: { tags: ["sessions"] },
        response: { 200: SessionStatus, 404: ErrorResponse },
      },
    )
    .delete(
      "/v1/sessions/:id",
      async ({ params }) => {
        if (!(await sessions.dispose(params.id))) return status(404, jsonError("session not found"))
        return { ok: true }
      },
      {
        params: t.Object({ id: t.String() }),
        detail: { tags: ["sessions"] },
        response: { 200: t.Object({ ok: t.Boolean() }), 404: ErrorResponse },
      },
    )
    .post(
      "/v1/sessions/:id/prompt",
      async ({ params, body }) => {
        try {
          await sessions.run(params.id, (session) => session.prompt(body.text))
          return { ok: true }
        } catch (error) {
          return status(404, jsonError(error instanceof Error ? error.message : String(error)))
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: PromptBody,
        detail: { tags: ["sessions"] },
        response: { 200: t.Object({ ok: t.Boolean() }), 404: ErrorResponse },
      },
    )
    .post(
      "/v1/sessions/:id/bash",
      async ({ params, body }) => {
        try {
          const result = await sessions.run(params.id, (session) =>
            session.executeBash(body.command, undefined, {
              excludeFromContext: body.excludeFromContext ?? false,
              id: params.id,
            }),
          )
          return { sessionId: params.id, command: body.command, result }
        } catch (error) {
          return status(404, jsonError(error instanceof Error ? error.message : String(error)))
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: BashBody,
        detail: {
          tags: ["sessions"],
          description:
            "run pi user-bash directly, without an agent turn; output is included in context by default",
        },
        response: { 200: t.Unknown(), 404: ErrorResponse },
      },
    )
    .post(
      "/v1/sessions/:id/abort",
      async ({ params }) => {
        const session = sessions.get(params.id)
        if (!session) return status(404, jsonError("session not found"))
        await session.session.abort()
        return { ok: true }
      },
      {
        params: t.Object({ id: t.String() }),
        detail: { tags: ["sessions"] },
        response: { 200: t.Object({ ok: t.Boolean() }), 404: ErrorResponse },
      },
    )
    .get(
      "/v1/sessions/:id/events",
      ({ params, query, request }) => {
        if (!sessions.get(params.id)) return status(404, jsonError("session not found"))
        const since = typeof query.since === "string" ? Number(query.since) : 0
        return eventStream(request, events, params.id, Number.isFinite(since) ? since : 0)
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ since: t.Optional(t.String()) }),
        detail: {
          tags: ["events"],
          description: "server-sent event stream for one pi session",
        },
        response: { 200: t.String(), 404: ErrorResponse },
      },
    )

  return { app, events, sessions }
}
