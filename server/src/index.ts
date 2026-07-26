import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { basename } from "node:path"
import { createApp } from "./app.ts"
import type { ServerConfig } from "./types.ts"

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function getConfig(): ServerConfig {
  return {
    host: process.env.PI_SERVER_HOST ?? "127.0.0.1",
    port: numberEnv("PI_SERVER_PORT", 3333),
    agentDir: process.env.PI_AGENT_DIR,
    authToken: process.env.PI_SERVER_AUTH_TOKEN,
    eventHistorySize: numberEnv("PI_SERVER_EVENT_HISTORY", 1000),
  }
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined

  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? "127.0.0.1"
  const url = new URL(request.url ?? "/", `http://${host}`)
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value)
  }

  const abortController = new AbortController()
  request.once("close", () => abortController.abort())

  return new Request(url, {
    method: request.method,
    headers,
    body: await readBody(request),
    signal: abortController.signal,
  })
}

async function writeWebResponse(response: Response, target: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  target.writeHead(response.status, headers)

  if (!response.body) {
    target.end()
    return
  }

  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!target.write(Buffer.from(value)))
        await new Promise<void>((resolve) => target.once("drain", resolve))
    }
  } catch {
    // the client disconnected while a stream was being written
  } finally {
    target.end()
  }
}

export async function startServer(config = getConfig()) {
  const { app, sessions } = createApp(config)
  const server = createServer(async (request, response) => {
    try {
      const webRequest = await toWebRequest(request)
      await writeWebResponse(await app.handle(webRequest), response)
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" })
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        )
      } else {
        response.destroy()
      }
    }
  })

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : config.port
  console.log(`pi-host listening on http://${config.host}:${port}`)
  console.log(`openapi: http://${config.host}:${port}/openapi`)

  const shutdown = async () => {
    await sessions.disposeAll()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  return { app, server, shutdown }
}

const entrypoint = basename(process.argv[1] ?? "")
if (entrypoint === "index.ts" || entrypoint === "index.js") await startServer()
