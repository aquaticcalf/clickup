import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"
import { DEFAULT_HOST, DEFAULT_PORT, STATE_FILE } from "./constants.ts"
import { CredentialStore } from "./auth/credential-store.ts"
import { DaemonService } from "./service.ts"

const execFileAsync = promisify(execFile)
const DAEMON_ENTRYPOINT = fileURLToPath(new URL("./daemon.ts", import.meta.url))

interface ServerState {
  pid: number
  host: string
  port: number
  startedAt: string
}

export interface ServerStatus {
  running: boolean
  enabled: boolean
  pid?: number
  host: string
  port: number
  url: string
  stateFile: string
}

function configuredPort(): number {
  const value = Number(process.env.PI_SERVER_PORT)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PORT
}

function statePath(): string {
  return join(process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"), STATE_FILE)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class ServerManager {
  private readonly credentials = new CredentialStore()
  private readonly service = new DaemonService()
  private sessionToken: string | undefined
  private readonly host = process.env.PI_SERVER_HOST || DEFAULT_HOST
  private readonly port = configuredPort()
  private readonly localUrl = `http://${this.host}:${this.port}`
  private readonly publicUrl = process.env.PI_SERVER_PUBLIC_URL || this.localUrl
  private readonly stateFile = statePath()

  private async loadState(): Promise<ServerState | undefined> {
    try {
      return JSON.parse(await readFile(this.stateFile, "utf8")) as ServerState
    } catch {
      return undefined
    }
  }

  private async saveState(state: ServerState): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    await writeFile(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  }

  private async removeState(): Promise<void> {
    try {
      await unlink(this.stateFile)
    } catch {
      // stale state is already gone
    }
  }

  private async health(token?: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.localUrl}/v1/health`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(1000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  async status(): Promise<ServerStatus> {
    const state = await this.loadState()
    const token = this.sessionToken ?? (await this.credentials.load())
    const healthy = await this.health(token)
    const enabled = await this.service.isInstalled()

    if (state && !isProcessAlive(state.pid) && !healthy) await this.removeState()

    return {
      running: healthy,
      enabled,
      pid: state?.pid,
      host: this.host,
      port: this.port,
      url: this.publicUrl,
      stateFile: this.stateFile,
    }
  }

  private async ensureToken(): Promise<{ token: string; stored: boolean; fresh: boolean }> {
    const saved = this.sessionToken ?? (await this.credentials.load())
    if (saved) {
      this.sessionToken = saved
      return { token: saved, stored: true, fresh: false }
    }

    const token = randomBytes(48).toString("base64url")
    this.sessionToken = token
    const stored = await this.credentials.save(token)
    return { token, stored, fresh: true }
  }

  private pairingPayload(token: string): string {
    return JSON.stringify({
      type: "pi-host-pairing",
      version: 1,
      endpoint: this.publicUrl,
      token,
    })
  }

  async start(): Promise<{
    status: ServerStatus
    credentialStored: boolean
    pairingPayload: string
  }> {
    const existing = await this.status()
    if (existing.running) {
      const token = this.sessionToken ?? (await this.credentials.load())
      return {
        status: existing,
        credentialStored: Boolean(token),
        pairingPayload: token ? this.pairingPayload(token) : "",
      }
    }

    const auth = await this.ensureToken()
    if (existing.enabled) {
      await this.service.start()
      await this.removeState()
    } else {
      const child = spawn(process.execPath, ["--experimental-strip-types", DAEMON_ENTRYPOINT], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          PI_SERVER_HOST: this.host,
          PI_SERVER_PORT: String(this.port),
          PI_SERVER_AUTH_TOKEN: auth.token,
        },
      })

      if (!child.pid) throw new Error("server process did not provide a pid")
      child.unref()

      await this.saveState({
        pid: child.pid,
        host: this.host,
        port: this.port,
        startedAt: new Date().toISOString(),
      })
    }

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await this.health(auth.token)) {
        return {
          status: await this.status(),
          credentialStored: auth.stored,
          pairingPayload: this.pairingPayload(auth.token),
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    await this.stop()
    throw new Error("server process started but did not become healthy")
  }

  async enable(): Promise<{
    status: ServerStatus
    credentialStored: boolean
    pairingPayload: string
  }> {
    const auth = await this.ensureToken()
    if (!auth.stored) {
      this.sessionToken = undefined
      throw new Error("the auth token could not be saved; automatic startup is unavailable")
    }

    const existing = await this.status()
    try {
      await this.service.install()
      if (!existing.running) await this.service.start()
      await this.removeState()
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await this.health(auth.token)) {
          return {
            status: await this.status(),
            credentialStored: true,
            pairingPayload: this.pairingPayload(auth.token),
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } catch (error) {
      await this.service.uninstall()
      throw error
    }

    await this.service.uninstall()
    throw new Error("automatic server process started but did not become healthy")
  }

  async stop(): Promise<boolean> {
    const enabled = await this.service.isInstalled()
    if (enabled) await this.service.uninstall()

    const state = await this.loadState()
    if (!state) {
      this.sessionToken = undefined
      return enabled
    }

    if (isProcessAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGTERM")
      } catch {
        // the process exited between the liveness check and the signal
      }

      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (!isProcessAlive(state.pid)) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      if (isProcessAlive(state.pid) && process.platform === "win32") {
        try {
          await execFileAsync("taskkill", ["/PID", String(state.pid), "/T", "/F"])
        } catch {
          // report stopped after clearing state; the next status check can detect it
        }
      }
    }

    await this.removeState()
    this.sessionToken = undefined
    return true
  }

  async logout(): Promise<boolean> {
    this.sessionToken = undefined
    return this.credentials.delete()
  }

  async hasEntrypoint(): Promise<boolean> {
    try {
      await access(DAEMON_ENTRYPOINT)
      return true
    } catch {
      return false
    }
  }
}
