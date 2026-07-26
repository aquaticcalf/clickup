import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

type PromptFile = {
  content: string
}

type RequestPayload = Record<string, unknown>

function isRecord(value: unknown): value is RequestPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasAnthropicMessageBlocks(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return false
    return message.content.some((block) => isRecord(block) && block.type === "text")
  })
}

const PROMPTS_DIRECTORY = fileURLToPath(new URL("../../prompts/", import.meta.url))
const STATE_FILE = join(homedir(), ".pi", "agent", "prompts.json")

type PromptsState = {
  enabled: boolean
  previousActiveTools?: string[]
}

async function loadPersistedState(): Promise<PromptsState> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8")) as Partial<PromptsState>
    return {
      enabled: parsed.enabled === true,
      previousActiveTools: Array.isArray(parsed.previousActiveTools)
        ? parsed.previousActiveTools.filter((name): name is string => typeof name === "string")
        : undefined,
    }
  } catch {
    return { enabled: false }
  }
}

async function savePersistedState(state: PromptsState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  const temporaryFile = `${STATE_FILE}.${process.pid}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporaryFile, STATE_FILE)
}

async function findTextFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await findTextFiles(path)))
    } else if (entry.isFile() && entry.name.endsWith(".txt")) {
      files.push(path)
    }
  }
  return files
}

async function loadPrompts(): Promise<PromptFile[]> {
  const paths = await findTextFiles(PROMPTS_DIRECTORY)
  return Promise.all(
    paths.map(async (path) => ({
      content: await readFile(path, "utf8"),
    })),
  )
}

export default async function prompts(pi: ExtensionAPI): Promise<void> {
  const promptFiles = await loadPrompts()
  const promptText = promptFiles
    .map((prompt) => prompt.content.trim())
    .filter((content) => content.length > 0)
    .join("\n\n")

  let localPromptsOnly = false
  let previousActiveTools: string[] | undefined

  pi.registerCommand("prompts", {
    description: "toggle between pi's prompt and local prompts",
    handler: async (_args, ctx) => {
      if (localPromptsOnly) {
        localPromptsOnly = false
        if (previousActiveTools) pi.setActiveTools(previousActiveTools)
        previousActiveTools = undefined
        try {
          await savePersistedState({ enabled: false })
        } catch (error) {
          ctx.ui.notify(
            `prompt mode preference could not be saved: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          )
        }
        ctx.ui.notify("pi's prompt and local prompts restored", "info")
        return
      }

      previousActiveTools = pi.getActiveTools()
      pi.setActiveTools(pi.getAllTools().map((tool) => tool.name))
      localPromptsOnly = true
      try {
        await savePersistedState({ enabled: true, previousActiveTools })
      } catch (error) {
        ctx.ui.notify(
          `prompt mode preference could not be saved: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        )
      }
      ctx.ui.notify("pi's prompt stopped; local prompts and all tools enabled", "info")
    },
  })

  pi.on("session_start", async () => {
    const state = await loadPersistedState()
    if (!state.enabled) return

    const availableTools = new Set(pi.getAllTools().map((tool) => tool.name))
    previousActiveTools =
      state.previousActiveTools?.filter((name) => availableTools.has(name)) ?? pi.getActiveTools()
    pi.setActiveTools(Array.from(availableTools))
    localPromptsOnly = true
  })

  pi.on("before_agent_start", () => {
    if (localPromptsOnly) return { systemPrompt: "" }
  })

  pi.on("before_provider_request", (event) => {
    if (!promptText || !isRecord(event.payload)) return

    const payload = { ...event.payload }

    if (Array.isArray(payload.input)) {
      let insertAt = 0
      while (insertAt < payload.input.length) {
        const item = payload.input[insertAt]
        if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) break
        insertAt++
      }
      const systemMessage = { role: "system", content: promptText }
      payload.input = [
        ...payload.input.slice(0, insertAt),
        systemMessage,
        ...payload.input.slice(insertAt),
      ]
      if (localPromptsOnly && "instructions" in payload) delete payload.instructions
      return payload
    }

    if (Array.isArray(payload.messages)) {
      if ("system" in payload || hasAnthropicMessageBlocks(payload.messages)) {
        const system = payload.system
        if (typeof system === "string") {
          payload.system = `${system}\n\n${promptText}`
        } else if (Array.isArray(system)) {
          payload.system = [...system, { type: "text", text: promptText }]
        } else {
          payload.system = [{ type: "text", text: promptText }]
        }
        return payload
      }

      let insertAt = 0
      while (insertAt < payload.messages.length) {
        const item = payload.messages[insertAt]
        if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) break
        insertAt++
      }
      const systemMessage = { role: "system", content: promptText }
      payload.messages = [
        ...payload.messages.slice(0, insertAt),
        systemMessage,
        ...payload.messages.slice(insertAt),
      ]
      return payload
    }

    if ("systemInstruction" in payload) {
      if (typeof payload.systemInstruction === "string") {
        payload.systemInstruction = `${payload.systemInstruction}\n\n${promptText}`
      } else {
        payload.systemInstruction = promptText
      }
      return payload
    }

    return
  })
}
