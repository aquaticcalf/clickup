import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { SoundEngine } from "./audio/sound-engine.ts"

const THEME_NAME = "casino"
const SUITS = ["♠", "♥", "♦", "♣"]
const REDUCED_MOTION = /^(1|true|yes)$/i.test(process.env.CASINO_REDUCED_MOTION ?? "")
const STATE_FILE = join(homedir(), ".pi", "agent", "casino.json")

type Theme = ReturnType<ExtensionContext["ui"]["getTheme"]>
type CasinoState = { enabled: boolean }

async function loadPersistedState(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8")) as Partial<CasinoState>
    return parsed.enabled === true
  } catch {
    return false
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

export default function casino(pi: ExtensionAPI): void {
  let enabled = false
  let previousTheme: Theme | undefined
  const sounds = new SoundEngine()

  const clearVisuals = (ctx: ExtensionContext): void => {
    if (ctx.mode === "tui") ctx.ui.setWorkingIndicator()
  }

  const disable = (ctx: ExtensionContext): void => {
    sounds.play("off")
    void sounds.disableAfterQueuedSounds()
    clearVisuals(ctx)
    if (previousTheme) ctx.ui.setTheme(previousTheme)
    previousTheme = undefined
    enabled = false
  }

  const enable = (ctx: ExtensionContext): boolean => {
    const originalTheme = ctx.ui.theme
    const casinoTheme = ctx.ui.getTheme(THEME_NAME)
    if (!casinoTheme) {
      ctx.ui.notify("Could not enable Casino Mode: theme unavailable", "error")
      return false
    }
    // Pass the Theme object, not the name: pi persists named theme selections.
    const result = ctx.ui.setTheme(casinoTheme)
    if (!result.success) {
      ctx.ui.notify(`Could not enable Casino Mode: ${result.error ?? "theme unavailable"}`, "error")
      return false
    }

    previousTheme = originalTheme
    enabled = true
    sounds.enable()
    sounds.play("on")

    if (ctx.mode === "tui") {
      const frames = REDUCED_MOTION
        ? [ctx.ui.theme.fg("accent", "♦")]
        : SUITS.map((suit) => ctx.ui.theme.fg("accent", suit))
      ctx.ui.setWorkingIndicator({ frames, intervalMs: REDUCED_MOTION ? 1000 : 650 })
    }
    return true
  }

  pi.registerCommand("casino", {
    description: "Toggle the refined casino visual theme and soundscape",
    handler: async (_args, ctx) => {
      if (enabled) disable(ctx)
      else enable(ctx)
      try {
        await savePersistedState(enabled)
      } catch (error) {
        ctx.ui.notify(
          `Casino preference could not be saved: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        )
      }
    },
  })

  pi.on("agent_start", () => {
    if (enabled) sounds.play("agentStart")
  })

  pi.on("tool_execution_start", () => {
    if (enabled) sounds.play("toolStart")
  })

  pi.on("tool_execution_end", (event) => {
    if (enabled) sounds.play(event.isError ? "toolError" : "toolSuccess")
  })

  pi.on("turn_end", () => {
    if (enabled) sounds.play("turnEnd")
  })

  pi.on("agent_settled", () => {
    if (enabled) sounds.play("settled")
  })

  pi.on("session_start", async (_event, ctx) => {
    enabled = false
    previousTheme = undefined
    sounds.stopImmediately()
    if (ctx.mode !== "tui" || !(await loadPersistedState())) return
    enable(ctx)
  })

  pi.on("session_shutdown", (_event, ctx) => {
    if (enabled) {
      sounds.stopImmediately()
      clearVisuals(ctx)
      if (previousTheme) ctx.ui.setTheme(previousTheme)
      enabled = false
      previousTheme = undefined
    } else {
      clearVisuals(ctx)
    }
  })
}
