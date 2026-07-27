import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent"

const REWRITE_TIMEOUT_MS = 2_000
const MIN_SUPPORTED_RTK: [number, number, number] = [0, 23, 0]
const STATE_FILE = join(homedir(), ".pi", "agent", "rtk.json")

type Version = [number, number, number]

type SessionStats = {
  rewritten: number
  passed: number
  errors: number
}

type RtkState = { enabled: boolean }

async function loadPersistedState(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8")) as Partial<RtkState>
    return parsed.enabled !== false
  } catch {
    return true
  }
}

async function savePersistedState(enabled: boolean): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  const temporaryFile = `${STATE_FILE}.${process.pid}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify({ enabled })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporaryFile, STATE_FILE)
}

function parseVersion(value: string): Version | undefined {
  const match = value.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isSupported(version: Version): boolean {
  for (let index = 0; index < version.length; index++) {
    if (version[index] !== MIN_SUPPORTED_RTK[index])
      return version[index] > MIN_SUPPORTED_RTK[index]
  }
  return true
}

function formatStats(version: string | undefined, enabled: boolean, stats: SessionStats): string {
  const total = stats.rewritten + stats.passed
  const rate = total === 0 ? 0 : Math.round((stats.rewritten / total) * 100)
  return [
    `rtk: ${enabled ? "on" : "off"}${version ? ` (${version})` : " (unavailable)"}`,
    `session: ${stats.rewritten} rewritten, ${stats.passed} passed, ${stats.errors} errors`,
    `rewrite rate: ${rate}%`,
  ].join("\n")
}

async function rewriteCommand(
  pi: ExtensionAPI,
  command: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await pi.exec("rtk", ["rewrite", command], {
    timeout: REWRITE_TIMEOUT_MS,
    signal,
  })
  if (result.killed || (result.code !== 0 && result.code !== 3)) return undefined
  const rewritten = result.stdout.trim()
  return rewritten || undefined
}

export default async function rtk(pi: ExtensionAPI): Promise<void> {
  let version: string | undefined
  let available = false
  let enabled = true
  let stats: SessionStats = { rewritten: 0, passed: 0, errors: 0 }

  const probe = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS })
  const parsed = parseVersion(probe.stdout)
  if (probe.code !== 0 || !parsed || !isSupported(parsed)) {
    const reason = probe.code !== 0 ? "not found in PATH" : "too old or invalid"
    console.warn(`[rtk] binary ${reason}; bash rewriting disabled`)
    enabled = false
  } else {
    available = true
    version = probe.stdout.trim()
  }

  pi.on("session_start", async () => {
    stats = { rewritten: 0, passed: 0, errors: 0 }
    enabled = available && (await loadPersistedState())
  })

  pi.on("tool_call", async (event, ctx) => {
    if (!available || !enabled || process.env.RTK_DISABLED === "1") return
    if (!isToolCallEventType("bash", event)) return

    const command = event.input.command
    if (typeof command !== "string" || command.trim() === "") return
    if (command.trimStart() === "rtk" || command.trimStart().startsWith("rtk ")) return

    try {
      const rewritten = await rewriteCommand(pi, command, ctx.signal)
      if (rewritten && rewritten !== command) {
        event.input.command = rewritten
        stats.rewritten++
      } else {
        stats.passed++
      }
    } catch (error) {
      stats.errors++
      console.warn(`[rtk] rewrite failed; passing through command: ${String(error)}`)
    }
  })

  pi.registerCommand("rtk", {
    description: "toggle RTK bash command rewriting and show status",
    handler: async (_args, ctx) => {
      if (!available) {
        ctx.ui.notify("rtk is unavailable; install it and add it to PATH", "warning")
        return
      }

      enabled = !enabled
      try {
        await savePersistedState(enabled)
      } catch (error) {
        ctx.ui.notify(
          `rtk preference could not be saved: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        )
      }
      ctx.ui.notify(formatStats(version, enabled, stats), "info")
    },
  })
}
