import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  STATE_FILE,
} from "./constants.ts";
import { CredentialStore } from "./auth/credential-store.ts";

const execFileAsync = promisify(execFile);
const SERVER_ENTRYPOINT = fileURLToPath(new URL("../../server/src/index.ts", import.meta.url));

interface ServerState {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
}

export interface ServerStatus {
  running: boolean;
  pid?: number;
  host: string;
  port: number;
  url: string;
  stateFile: string;
}

function configuredPort(): number {
  const value = Number(process.env.PI_SERVER_PORT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PORT;
}

function statePath(): string {
  return join(process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"), STATE_FILE);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ServerManager {
  private readonly credentials = new CredentialStore();
  private sessionToken: string | undefined;
  private readonly host = process.env.PI_SERVER_HOST || DEFAULT_HOST;
  private readonly port = configuredPort();
  private readonly localUrl = `http://${this.host}:${this.port}`;
  private readonly publicUrl = process.env.PI_SERVER_PUBLIC_URL || this.localUrl;
  private readonly stateFile = statePath();

  private async loadState(): Promise<ServerState | undefined> {
    try {
      return JSON.parse(await readFile(this.stateFile, "utf8")) as ServerState;
    } catch {
      return undefined;
    }
  }

  private async saveState(state: ServerState): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private async removeState(): Promise<void> {
    try {
      await unlink(this.stateFile);
    } catch {
      // stale state is already gone
    }
  }

  private async health(token?: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.localUrl}/v1/health`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(1000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async status(): Promise<ServerStatus> {
    const state = await this.loadState();
    const token = this.sessionToken ?? (await this.credentials.load());
    const healthy = await this.health(token);

    if (state && !isProcessAlive(state.pid) && !healthy) await this.removeState();

    return {
      running: healthy,
      pid: state?.pid,
      host: this.host,
      port: this.port,
      url: this.publicUrl,
      stateFile: this.stateFile,
    };
  }

  async start(): Promise<{
    status: ServerStatus;
    credentialStored: boolean;
    pairingPayload: string;
  }> {
    const existing = await this.status();
    if (existing.running) {
      return {
        status: existing,
        credentialStored: true,
        pairingPayload: "",
      };
    }

    const token = randomBytes(48).toString("base64url");
    this.sessionToken = token;
    const credentialStored = await this.credentials.save(token);
    const child = spawn(process.execPath, ["--experimental-strip-types", SERVER_ENTRYPOINT], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        PI_SERVER_HOST: this.host,
        PI_SERVER_PORT: String(this.port),
        PI_SERVER_AUTH_TOKEN: token,
      },
    });

    if (!child.pid) throw new Error("server process did not provide a pid");
    child.unref();

    await this.saveState({
      pid: child.pid,
      host: this.host,
      port: this.port,
      startedAt: new Date().toISOString(),
    });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await this.health(token)) {
        return {
          status: await this.status(),
          credentialStored,
          pairingPayload: JSON.stringify({
            type: "pi-host-pairing",
            version: 1,
            endpoint: this.publicUrl,
            token,
          }),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await this.stop();
    throw new Error("server process started but did not become healthy");
  }

  async stop(): Promise<boolean> {
    const state = await this.loadState();
    if (!state) return false;

    if (isProcessAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // the process exited between the liveness check and the signal
      }

      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (!isProcessAlive(state.pid)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (isProcessAlive(state.pid) && process.platform === "win32") {
        try {
          await execFileAsync("taskkill", ["/PID", String(state.pid), "/T", "/F"]);
        } catch {
          // report stopped after clearing state; the next status check can detect it
        }
      }
    }

    await this.removeState();
    this.sessionToken = undefined;
    return true;
  }

  async logout(): Promise<boolean> {
    this.sessionToken = undefined;
    return this.credentials.delete();
  }

  async hasEntrypoint(): Promise<boolean> {
    try {
      await access(SERVER_ENTRYPOINT);
      return true;
    } catch {
      return false;
    }
  }
}
