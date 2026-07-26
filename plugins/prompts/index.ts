import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

type PromptFile = {
  content: string
}

const PROMPTS_DIRECTORY = fileURLToPath(new URL("../../prompts/", import.meta.url))

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

  if (!promptText) return

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${promptText}`,
  }))
}
