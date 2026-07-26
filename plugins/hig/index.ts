import { spawn } from "node:child_process"
import { userInfo } from "node:os"
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent"
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type EditorOptions,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui"

const THEME_NAME = "hig"
const ALT_SCREEN_ON = "\u001b[?1049h\u001b[2J\u001b[H"
const ALT_SCREEN_OFF = "\u001b[?1049l"
const MOUSE_ON = "\u001b[?1002h\u001b[?1006h"
const MOUSE_OFF = "\u001b[?1002l\u001b[?1006l"
const FACE_WIDTH = 45
const FACE_HEIGHT = 14
const REDUCED_MOTION = /^(1|true|yes)$/i.test(process.env.HIG_REDUCED_MOTION ?? "")
const ESCAPE = String.fromCharCode(0x1b)
const BELL = String.fromCharCode(0x07)
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  "g",
)
const SGR_MOUSE = new RegExp(`^${ESCAPE}\\[<(\\d+);(\\d+);(\\d+)([mM])$`)
const ANSI_ESCAPE = new RegExp(
  `${ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\))`,
  "g",
)

function getUserName(): string {
  try {
    return userInfo().username.replace(CONTROL_CHARACTERS, "").trim()
  } catch {
    return ""
  }
}

const USER_NAME = getUserName()
const GREETING_TEXT = USER_NAME ? `hi, ${USER_NAME}` : "hi"

function buildCuteFrame(expression: string): string[] {
  const rows = Array.from({ length: FACE_HEIGHT }, () => " ".repeat(FACE_WIDTH))

  const put = (text: string, row: number): void => {
    const fitted = truncateToWidth(text, FACE_WIDTH, "")
    const textWidth = visibleWidth(fitted)
    const start = Math.max(0, Math.floor((FACE_WIDTH - textWidth) / 2))
    const right = Math.max(0, FACE_WIDTH - start - textWidth)
    rows[row] = " ".repeat(start) + fitted + " ".repeat(right)
  }

  put(`*:･ﾟ✧*:･ﾟ✧ ${GREETING_TEXT} ${expression} ✧ﾟ･: *✧ﾟ･:*`, 6)
  put("♡ ( =^･ω･^= ) ♡", 8)

  return rows
}

const FACE_FRAMES = [
  buildCuteFrame(">_<"),
  buildCuteFrame(">_>"),
  buildCuteFrame(">_<"),
  buildCuteFrame("U_U"),
]

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY)
}

function enterAlternateScreen(): boolean {
  if (!isInteractiveTerminal()) return false
  process.stdout.write(ALT_SCREEN_ON)
  return true
}

function leaveAlternateScreen(): void {
  if (!isInteractiveTerminal()) return
  process.stdout.write(ALT_SCREEN_OFF)
}

function hasConversation(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) => entry.type === "message")
}

function getComponentChildren(component: unknown): unknown[] | undefined {
  if (typeof component !== "object" || component === null || !("children" in component)) {
    return undefined
  }
  const children = (component as { children?: unknown }).children
  return Array.isArray(children) ? children : undefined
}

type RenderableContainer = {
  render(width: number): string[]
}

/**
 * The core TUI keeps the editor focused and renders the whole conversation above
 * it. Give the conversation its own viewport so wheel/page scrolling never
 * reaches CustomEditor (where Up/Down correctly mean prompt history).
 */
class ChatViewport {
  private readonly originalRender: (width: number) => string[]
  private viewportRows = 0
  private visibleRows = 0
  private lineCount = 0
  private scrollOffset = 0
  private visibleLines: string[] = []
  private screenTop = 0
  private selectionStart: MousePoint | undefined
  private selectionEnd: MousePoint | undefined
  private selecting = false
  private copyFlash:
    | { bounds: { start: MousePoint; end: MousePoint }; startedAt: number }
    | undefined

  constructor(
    private readonly container: RenderableContainer,
    private readonly theme: Theme,
  ) {
    this.originalRender = container.render.bind(container)
    container.render = (width: number): string[] => {
      const lines = this.originalRender(width)
      this.lineCount = lines.length
      const rows = this.viewportRows > 0 ? this.viewportRows : lines.length
      const maxOffset = Math.max(0, lines.length - rows)
      this.scrollOffset = Math.min(this.scrollOffset, maxOffset)
      const end = Math.max(0, lines.length - this.scrollOffset)
      const start = Math.max(0, end - rows)
      const visible = lines.slice(start, end)
      this.visibleLines = visible
      this.visibleRows = visible.length
      return visible.map((line, index) => this.highlightLine(line, index))
    }
  }

  getVisibleRows(): number {
    return this.visibleRows
  }

  setScreenTop(row: number): void {
    this.screenTop = Math.max(0, row)
  }

  private textRange(row: number): { start: number; end: number } | undefined {
    const line = stripAnsi(this.visibleLines[row] ?? "")
    const firstText = line.search(/\S/u)
    if (firstText < 0) return undefined
    const lastText = line.trimEnd()
    return {
      start: visibleWidth(line.slice(0, firstText)),
      end: visibleWidth(lastText),
    }
  }

  private pointAt(x: number, y: number, clamp: boolean): MousePoint | undefined {
    const localY = y - this.screenTop
    if (!clamp && (localY < 0 || localY >= this.visibleLines.length)) return undefined
    if (this.visibleLines.length === 0) return undefined
    const row = Math.max(0, Math.min(this.visibleLines.length - 1, localY))
    const range = this.textRange(row)
    if (!range) return { x: 0, y: row }
    return { x: Math.max(range.start, Math.min(range.end, x)), y: row }
  }

  beginSelection(x: number, y: number): boolean {
    this.copyFlash = undefined
    const point = this.pointAt(x, y, false)
    if (!point) return false
    this.selectionStart = point
    this.selectionEnd = point
    this.selecting = true
    return true
  }

  updateSelection(x: number, y: number): boolean {
    if (!this.selecting) return false
    const point = this.pointAt(x, y, true)
    if (!point) return false
    this.selectionEnd = point
    return true
  }

  finishSelection(x: number, y: number): string | undefined {
    this.updateSelection(x, y)
    this.selecting = false
    const selected = this.getSelectedText()
    if (selected) this.startCopyFlash()
    return selected
  }

  private startCopyFlash(): void {
    const bounds = this.getSelectionBounds()
    if (!bounds) return
    this.copyFlash = {
      bounds: {
        start: { ...bounds.start },
        end: { ...bounds.end },
      },
      startedAt: Date.now(),
    }
    this.selectionStart = undefined
    this.selectionEnd = undefined
  }

  hasCopyFlash(): boolean {
    return this.copyFlash !== undefined
  }

  advanceCopyFlash(): boolean {
    if (!this.copyFlash) return false
    if (Date.now() - this.copyFlash.startedAt >= 420) {
      this.copyFlash = undefined
      return false
    }
    return true
  }

  clearSelection(): void {
    this.selectionStart = undefined
    this.selectionEnd = undefined
    this.selecting = false
    this.copyFlash = undefined
  }

  getSelectedText(): string | undefined {
    const bounds = this.getSelectionBounds()
    if (!bounds) return undefined
    const parts: string[] = []
    for (let row = bounds.start.y; row <= bounds.end.y; row++) {
      const line = stripAnsi(this.visibleLines[row])
      const range = this.textRange(row)
      if (!range) {
        parts.push("")
        continue
      }
      const from = row === bounds.start.y ? Math.max(range.start, bounds.start.x) : range.start
      const to = row === bounds.end.y ? Math.min(range.end, bounds.end.x) : range.end
      parts.push(sliceByColumn(line, from, Math.max(0, to - from), true))
    }
    const text = parts.join("\n").replace(/\n+$/u, "")
    return text.length > 0 ? text : undefined
  }

  private getSelectionBounds(): { start: MousePoint; end: MousePoint } | undefined {
    if (!this.selectionStart || !this.selectionEnd) return undefined
    const startBeforeEnd =
      this.selectionStart.y < this.selectionEnd.y ||
      (this.selectionStart.y === this.selectionEnd.y &&
        this.selectionStart.x <= this.selectionEnd.x)
    return startBeforeEnd
      ? { start: this.selectionStart, end: this.selectionEnd }
      : { start: this.selectionEnd, end: this.selectionStart }
  }

  private highlightLine(line: string, row: number): string {
    const activeBounds = this.getSelectionBounds() ?? this.copyFlash?.bounds
    if (!activeBounds || row < activeBounds.start.y || row > activeBounds.end.y) return line
    const range = this.textRange(row)
    if (!range) return line
    const from =
      row === activeBounds.start.y ? Math.max(range.start, activeBounds.start.x) : range.start
    const to = row === activeBounds.end.y ? Math.min(range.end, activeBounds.end.x) : range.end
    if (to <= from) return line
    const selected = sliceByColumn(line, from, to - from, true)
    const selectedWidth = visibleWidth(selected)
    if (selectedWidth === 0) return line
    const before = sliceByColumn(line, 0, from)
    const after = sliceByColumn(
      line,
      from + selectedWidth,
      Math.max(0, visibleWidth(line) - from - selectedWidth),
    )
    const flashAge = this.copyFlash ? Date.now() - this.copyFlash.startedAt : -1
    if (flashAge < 0) return `${before}\u001b[7m${stripAnsi(selected)}\u001b[27m${after}`
    const flashBackground =
      flashAge < 140 ? "selectedBg" : flashAge < 280 ? "customMessageBg" : "userMessageBg"
    return `${before}${this.theme.bg(flashBackground, stripAnsi(selected))}${after}`
  }

  setViewportRows(rows: number): boolean {
    const nextRows = Math.max(0, rows)
    const changed = this.viewportRows !== nextRows
    this.viewportRows = nextRows
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.lineCount - nextRows))
    return changed
  }

  scrollBy(lines: number): boolean {
    const maxOffset = Math.max(0, this.lineCount - this.viewportRows)
    const nextOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + lines))
    if (nextOffset === this.scrollOffset) return false
    this.scrollOffset = nextOffset
    return true
  }

  dispose(): void {
    this.container.render = this.originalRender
  }
}

type MousePoint = {
  x: number
  y: number
}

type MouseInput =
  | { kind: "wheel"; delta: number }
  | { kind: "press" | "release" | "motion"; button: number; x: number; y: number }

function parseMouseInput(data: string): MouseInput | undefined {
  const sgr = data.match(SGR_MOUSE)
  if (sgr) {
    const code = Number.parseInt(sgr[1], 10)
    const x = Number.parseInt(sgr[2], 10) - 1
    const y = Number.parseInt(sgr[3], 10) - 1
    if ((code & 64) !== 0) {
      return { kind: "wheel", delta: (code & 1) === 0 ? 3 : -3 }
    }
    const kind = (code & 32) !== 0 ? "motion" : sgr[4] === "m" ? "release" : "press"
    return { kind, button: code & 3, x, y }
  }

  // Legacy X10 mouse encoding: ESC [ M button x y.
  if (data.startsWith("\u001b[M") && data.length >= 6) {
    const code = data.charCodeAt(3) - 32
    const x = data.charCodeAt(4) - 33
    const y = data.charCodeAt(5) - 33
    if ((code & 64) !== 0) {
      return { kind: "wheel", delta: (code & 1) === 0 ? 3 : -3 }
    }
    return { kind: "press", button: code & 3, x, y }
  }
  return undefined
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "")
}

function copyWithCommand(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true })
    let settled = false
    const finish = (copied: boolean): void => {
      if (settled) return
      settled = true
      resolve(copied)
    }
    child.once("error", () => finish(false))
    child.once("close", (code) => finish(code === 0))
    child.stdin.on("error", () => finish(false))
    child.stdin.end(text)
  })
}

async function copyToClipboard(text: string): Promise<void> {
  let copied = false
  if (process.platform === "win32") copied = await copyWithCommand("clip", [], text)
  else if (process.platform === "darwin") copied = await copyWithCommand("pbcopy", [], text)
  else if (process.env.WAYLAND_DISPLAY) copied = await copyWithCommand("wl-copy", [], text)
  else if (process.env.DISPLAY) {
    copied = await copyWithCommand("xclip", ["-selection", "clipboard"], text)
    if (!copied) copied = await copyWithCommand("xsel", ["--clipboard", "--input"], text)
  }

  if (copied) return
  const encoded = Buffer.from(text, "utf8").toString("base64")
  if (encoded.length <= 100_000) process.stdout.write(`\u001b]52;c;${encoded}\u0007`)
}

class HIGEditor extends CustomEditor {
  constructor(
    higTui: TUI,
    theme: EditorTheme,
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    options: EditorOptions | undefined,
    private readonly ctx: ExtensionContext,
    private readonly frameProvider: () => string[],
    private readonly chatViewport: ChatViewport | undefined,
  ) {
    super(higTui, theme, keybindings, options)
    this.higTui = higTui
    this.higKeybindings = keybindings
  }

  private readonly higTui: TUI
  private readonly higKeybindings: ConstructorParameters<typeof CustomEditor>[2]

  override handleInput(data: string): void {
    if (this.chatViewport && this.higKeybindings.matches(data, "tui.editor.pageUp")) {
      if (this.chatViewport.scrollBy(3)) this.higTui.requestRender()
      return
    }
    if (this.chatViewport && this.higKeybindings.matches(data, "tui.editor.pageDown")) {
      if (this.chatViewport.scrollBy(-3)) this.higTui.requestRender()
      return
    }
    super.handleInput(data)
  }

  override render(width: number): string[] {
    const editorLines = super.render(width)
    const editorContainerIndex = this.higTui.children.findIndex((child) =>
      getComponentChildren(child)?.includes(this),
    )
    const rowsBeforeEditor =
      editorContainerIndex < 0
        ? 0
        : this.higTui.children
            .slice(0, editorContainerIndex)
            .reduce((rows, child) => rows + child.render(width).length, 0)
    const rowsAfterEditor =
      editorContainerIndex < 0
        ? 0
        : this.higTui.children
            .slice(editorContainerIndex + 1)
            .reduce((rows, child) => rows + child.render(width).length, 0)
    const rowsBeforeChat = this.chatViewport
      ? Math.max(0, rowsBeforeEditor - this.chatViewport.getVisibleRows())
      : rowsBeforeEditor
    const desiredChatRows = Math.max(
      0,
      this.higTui.terminal.rows - rowsBeforeChat - rowsAfterEditor - editorLines.length,
    )
    if (this.chatViewport?.setViewportRows(desiredChatRows)) {
      this.higTui.requestRender()
    }
    this.chatViewport?.setScreenTop(rowsBeforeChat)
    const adjustedRowsBeforeEditor = rowsBeforeChat + (this.chatViewport?.getVisibleRows() ?? 0)
    const availableRows = Math.max(
      0,
      this.higTui.terminal.rows - adjustedRowsBeforeEditor - rowsAfterEditor - editorLines.length,
    )

    if (hasConversation(this.ctx)) {
      return [...Array.from({ length: availableRows }, () => ""), ...editorLines]
    }

    const face = this.frameProvider()
    const markSpace = Math.max(face.length, availableRows)
    const topSpace = Math.max(0, Math.floor((markSpace - face.length) / 2))
    const bottomSpace = Math.max(0, markSpace - topSpace - face.length)
    const mark = face.map((line) => {
      const greeting = line.replace(GREETING_TEXT, this.ctx.ui.theme.bold(GREETING_TEXT))
      const styled = this.ctx.ui.theme.fg("accent", greeting)
      if (width < FACE_WIDTH) return truncateToWidth(styled, width, "")
      const left = Math.floor((width - FACE_WIDTH) / 2)
      return `${" ".repeat(left)}${styled}${" ".repeat(width - left - FACE_WIDTH)}`
    })

    return [
      ...Array.from({ length: topSpace }, () => ""),
      ...mark,
      ...Array.from({ length: bottomSpace }, () => ""),
      ...editorLines,
    ]
  }
}

export default function hig(pi: ExtensionAPI): void {
  let inAlternateScreen = false
  let mouseTrackingEnabled = false
  let animationTimer: ReturnType<typeof setInterval> | undefined
  let requestRender: (() => void) | undefined
  let removeTerminalInputListener: (() => void) | undefined
  let chatViewport: ChatViewport | undefined
  let mouseSelecting = false
  let copyFlashTimer: ReturnType<typeof setInterval> | undefined
  let frameIndex = 0

  process.once("exit", () => {
    if (removeTerminalInputListener) removeTerminalInputListener()
    if (mouseTrackingEnabled) process.stdout.write(MOUSE_OFF)
    if (inAlternateScreen) leaveAlternateScreen()
  })

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return

    inAlternateScreen = enterAlternateScreen()
    mouseTrackingEnabled = isInteractiveTerminal()
    if (mouseTrackingEnabled) process.stdout.write(MOUSE_ON)
    const theme = ctx.ui.getTheme(THEME_NAME)
    if (theme) ctx.ui.setTheme(theme)

    frameIndex = 0
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      requestRender = () => tui.requestRender()
      const chatContainer = tui.children[2] as RenderableContainer | undefined
      chatViewport?.dispose()
      chatViewport = chatContainer ? new ChatViewport(chatContainer, ctx.ui.theme) : undefined
      return new HIGEditor(
        tui,
        editorTheme,
        keybindings,
        undefined,
        ctx,
        () => FACE_FRAMES[frameIndex],
        chatViewport,
      )
    })

    removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
      if (!chatViewport) return undefined

      if (data === "\u0003") {
        const selected = chatViewport.getSelectedText()
        if (selected) {
          void copyToClipboard(selected)
          return { consume: true }
        }
      }

      const mouse = parseMouseInput(data)
      if (!mouse) return undefined
      if (mouse.kind === "wheel") {
        chatViewport.clearSelection()
        if (chatViewport.scrollBy(mouse.delta)) requestRender?.()
        return { consume: true }
      }

      if (mouse.kind === "press" && mouse.button === 0) {
        mouseSelecting = chatViewport.beginSelection(mouse.x, mouse.y)
        if (mouseSelecting) requestRender?.()
        return { consume: true }
      }
      if (mouseSelecting && mouse.kind === "motion") {
        if (chatViewport.updateSelection(mouse.x, mouse.y)) requestRender?.()
        return { consume: true }
      }
      if (mouseSelecting && mouse.kind === "release" && mouse.button === 0) {
        const selected = chatViewport.finishSelection(mouse.x, mouse.y)
        mouseSelecting = false
        requestRender?.()
        if (selected && chatViewport.hasCopyFlash()) {
          void copyToClipboard(selected)
          if (copyFlashTimer) clearInterval(copyFlashTimer)
          copyFlashTimer = setInterval(() => {
            if (!chatViewport?.advanceCopyFlash()) {
              if (copyFlashTimer) clearInterval(copyFlashTimer)
              copyFlashTimer = undefined
            }
            requestRender?.()
          }, 30)
        }
        return { consume: true }
      }
      return { consume: true }
    })

    if (!REDUCED_MOTION) {
      animationTimer = setInterval(() => {
        if (!hasConversation(ctx)) {
          frameIndex = (frameIndex + 1) % FACE_FRAMES.length
          requestRender?.()
        }
      }, 750)
    }
  })

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return
    if (animationTimer) clearInterval(animationTimer)
    if (copyFlashTimer) clearInterval(copyFlashTimer)
    copyFlashTimer = undefined
    removeTerminalInputListener?.()
    removeTerminalInputListener = undefined
    chatViewport?.dispose()
    chatViewport = undefined
    mouseSelecting = false
    if (mouseTrackingEnabled) process.stdout.write(MOUSE_OFF)
    mouseTrackingEnabled = false
    animationTimer = undefined
    requestRender = undefined
    ctx.ui.setEditorComponent(undefined)
    if (inAlternateScreen) {
      leaveAlternateScreen()
      inAlternateScreen = false
    }
  })
}
