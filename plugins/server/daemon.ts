import { mkdir, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { CredentialStore } from "./auth/credential-store.ts"
import { STATE_FILE } from "./constants.ts"
import { getConfig, startServer } from "../../server/src/index.ts"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function statePath(): string {
  return join(process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"), STATE_FILE)
}

const host = argument("--host")
const port = argument("--port")
if (host) process.env.PI_SERVER_HOST = host
if (port) process.env.PI_SERVER_PORT = port

const token = process.env.PI_SERVER_AUTH_TOKEN ?? (await new CredentialStore().load())
if (!token) throw new Error("pi-host auth token is not available in the credential store")

process.env.PI_SERVER_AUTH_TOKEN = token
const config = getConfig()
await startServer(config)
await mkdir(dirname(statePath()), { recursive: true })
await writeFile(
  statePath(),
  `${JSON.stringify({ pid: process.pid, host: config.host, port: config.port, startedAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8",
)

const clearState = async () => {
  try {
    await unlink(statePath())
  } catch {
    // the state file may already be gone
  }
}

process.once("SIGINT", () => void clearState())
process.once("SIGTERM", () => void clearState())
