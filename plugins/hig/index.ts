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
const ALT_SCREEN_CLEAR = "\u001b[2J\u001b[H\u001b[3J"
const PRIMARY_TERMINAL_CLEAR = "\u001b[2J\u001b[H\u001b[3J"
const ALT_SCREEN_OFF = "\u001b[?1049l"
const MOUSE_ON = "\u001b[?1002h\u001b[?1006h"
const MOUSE_OFF = "\u001b[?1002l\u001b[?1006l"
const FACE_WIDTH = 45
const FACE_HEIGHT = 14
const EDITOR_MIN_ROWS = 3
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
  process.stdout.write(ALT_SCREEN_CLEAR)
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

function isRenderable(component: unknown): component is { render(width: number): string[] } {
  return (
    typeof component === "object" &&
    component !== null &&
    "render" in component &&
    typeof component.render === "function"
  )
}

type RenderableContainer = {
  render(width: number): string[]
}

const STATUS_EXIT_FADE_MS = 60

function reserveRows(
  container: RenderableContainer,
  rows: number,
  requestRender: () => void,
): () => void {
  const originalRender = container.render.bind(container)
  let lastLines: string[] | undefined
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  let exitAt = 0

  const padded = (lines: string[]): string[] =>
    lines.length >= rows
      ? lines
      : [...lines, ...Array.from({ length: rows - lines.length }, () => "")]

  container.render = (width: number): string[] => {
    const lines = originalRender(width)
    if (lines.length > 0) {
      if (exitTimer) clearTimeout(exitTimer)
      exitTimer = undefined
      exitAt = 0
      lastLines = lines
      return padded(lines)
    }

    if (lastLines && exitAt === 0) {
      exitAt = Date.now() + STATUS_EXIT_FADE_MS
      exitTimer = setTimeout(() => {
        exitTimer = undefined
        requestRender()
      }, STATUS_EXIT_FADE_MS)
    }

    if (lastLines && Date.now() < exitAt) {
      const faded = lastLines.map((line) =>
        line.length === 0 ? line : `\u001b[2m${stripAnsi(line)}\u001b[22m`,
      )
      return padded(faded)
    }
    lastLines = undefined
    exitAt = 0
    return padded([])
  }

  return () => {
    if (exitTimer) clearTimeout(exitTimer)
    container.render = originalRender
  }
}

type EditorLayoutSource = {
  getBaseEditorLines(width: number): string[]
}

type FlexItem = {
  basis: number
  minSize?: number
  grow?: number
  shrink?: number
  shrinkPriority?: number
}

type FlexSlot = {
  start: number
  size: number
}

/**
 * A small vertical flex engine for the pieces HIG controls. Fixed-height
 * sections keep their natural size, the conversation shrinks into the
 * viewport, and the editor receives any remaining space.
 */
class FlexColumn {
  private readonly items: FlexItem[]

  constructor(items: FlexItem[]) {
    this.items = items
  }

  layout(available: number): FlexSlot[] {
    const height = Math.max(0, available)
    const sizes = this.items.map((item) => Math.max(item.minSize ?? 0, item.basis))
    const minimums = this.items.map((item) => Math.max(0, item.minSize ?? 0))
    const naturalHeight = sizes.reduce((total, size) => total + size, 0)

    if (naturalHeight < height) {
      this.distribute(
        sizes,
        height - naturalHeight,
        this.items.map((item) => item.grow ?? 0),
      )
    } else if (naturalHeight > height) {
      let deficit = naturalHeight - height
      const priorities = [
        ...new Set(
          this.items
            .filter((item) => (item.shrink ?? 0) > 0)
            .map((item) => item.shrinkPriority ?? 0),
        ),
      ].sort((a, b) => b - a)

      for (const priority of priorities) {
        if (deficit <= 0) break
        const weights = this.items.map((item, index) =>
          (item.shrinkPriority ?? 0) === priority
            ? (sizes[index] - minimums[index]) * (item.shrink ?? 0)
            : 0,
        )
        const capacity = weights.reduce((total, weight) => total + weight, 0)
        const reduction = Math.min(deficit, capacity)
        this.distribute(sizes, -reduction, weights, minimums)
        deficit -= reduction
      }
    }

    const slots: FlexSlot[] = []
    let start = 0
    for (const size of sizes) {
      slots.push({ start, size })
      start += size
    }
    return slots
  }

  private distribute(
    sizes: number[],
    amount: number,
    weights: number[],
    minimums: number[] = [],
  ): void {
    const totalWeight = weights.reduce((total, weight) => total + weight, 0)
    if (totalWeight <= 0 || amount === 0) return

    const direction = amount < 0 ? -1 : 1
    const target = Math.abs(amount)
    const changes = weights.map((weight) => (weight / totalWeight) * target)
    const wholeChanges = changes.map((change) => Math.floor(change))
    let distributed = wholeChanges.reduce((total, change) => total + change, 0)

    // Give leftover rows to the items with the largest fractional shares.
    const order = changes
      .map((change, index) => ({ index, fraction: change - wholeChanges[index] }))
      .sort((a, b) => b.fraction - a.fraction)
    for (const { index } of order) {
      if (distributed >= target) break
      wholeChanges[index] += 1
      distributed += 1
    }

    for (let index = 0; index < sizes.length; index++) {
      sizes[index] = Math.max(minimums[index] ?? 0, sizes[index] + direction * wholeChanges[index])
    }
  }
}

type ChatLayout = {
  slots: {
    beforeChat: FlexSlot
    chat: FlexSlot
    betweenChatAndEditor: FlexSlot
    editor: FlexSlot
    afterEditor: FlexSlot
  }
  editorRows: number
}

/**
 * Builds and caches the vertical layout shared by the chat viewport and the
 * editor. Keeping this here prevents both components from independently
 * reproducing viewport arithmetic during the same render.
 */
class HIGFlex {
  private cacheKey = ""
  private cachedLayout: ChatLayout | undefined

  layout(
    width: number,
    terminalRows: number,
    lineCount: number,
    rowsBeforeChat: number,
    rowsBetweenChatAndEditor: number,
    editorRows: number,
    rowsAfterEditor: number,
  ): ChatLayout {
    const key = [
      width,
      terminalRows,
      lineCount,
      rowsBeforeChat,
      rowsBetweenChatAndEditor,
      editorRows,
      rowsAfterEditor,
    ].join(":")
    if (key === this.cacheKey && this.cachedLayout) return this.cachedLayout

    const [beforeChat, chat, betweenChatAndEditor, editor, afterEditor] = new FlexColumn([
      { basis: rowsBeforeChat },
      { basis: lineCount, shrink: 1, shrinkPriority: 2 },
      { basis: rowsBetweenChatAndEditor },
      {
        basis: Math.min(editorRows, EDITOR_MIN_ROWS),
        minSize: EDITOR_MIN_ROWS,
        grow: 1,
        shrink: 1,
        shrinkPriority: 1,
      },
      { basis: rowsAfterEditor },
    ]).layout(terminalRows)

    this.cacheKey = key
    this.cachedLayout = {
      slots: { beforeChat, chat, betweenChatAndEditor, editor, afterEditor },
      editorRows,
    }
    return this.cachedLayout
  }
}

/**
 * The core TUI keeps the editor focused and renders the whole conversation above
 * it. Give the conversation its own viewport so wheel/page scrolling never
 * reaches CustomEditor (where Up/Down correctly mean prompt history).
 */
class ChatViewport {
  private readonly originalRender: (width: number) => string[]
  private viewportRows = 0
  private lineCount = 0
  private scrollOffset = 0
  private visibleLines: string[] = []
  private screenTop = 0
  private layout: ChatLayout | undefined
  private selectionStart: MousePoint | undefined
  private selectionEnd: MousePoint | undefined
  private selecting = false
  private copyFlash:
    | { bounds: { start: MousePoint; end: MousePoint }; startedAt: number }
    | undefined

  constructor(
    private readonly tui: TUI,
    private readonly container: RenderableContainer,
    private readonly editor: EditorLayoutSource,
    private readonly theme: Theme,
    private readonly flex: HIGFlex,
  ) {
    this.originalRender = container.render.bind(container)
    container.render = (width: number): string[] => {
      const lines = this.originalRender(width)
      this.lineCount = lines.length
      this.layout = this.measureLayout(width)
      this.setViewportRows(this.layout.slots.chat.size)
      const rows = this.viewportRows
      const maxOffset = Math.max(0, lines.length - rows)
      this.scrollOffset = Math.min(this.scrollOffset, maxOffset)
      const end = Math.max(0, lines.length - this.scrollOffset)
      const start = Math.max(0, end - rows)
      const visible = lines.slice(start, end)
      this.visibleLines = visible
      return visible.map((line, index) => this.highlightLine(line, index))
    }
  }

  private measureLayout(width: number): ChatLayout {
    const children = this.tui.children as unknown[]
    const chatIndex = children.indexOf(this.container)
    const editorContainerIndex = children.findIndex((child) =>
      getComponentChildren(child)?.includes(this.editor),
    )
    const editorIndex = editorContainerIndex >= 0 ? editorContainerIndex : children.length
    const rows = (start: number, end: number): number =>
      children.slice(Math.max(0, start), Math.max(0, end)).reduce<number>((total, child) => {
        if (!isRenderable(child)) return total
        return total + child.render(width).length
      }, 0)

    const editorRows = this.editor.getBaseEditorLines(width).length
    const rowsBeforeChat = rows(0, chatIndex)
    const rowsBetweenChatAndEditor = rows(chatIndex + 1, editorIndex)
    const rowsAfterEditor = rows(editorIndex + 1, children.length)
    return this.flex.layout(
      width,
      this.tui.terminal.rows,
      this.lineCount,
      rowsBeforeChat,
      rowsBetweenChatAndEditor,
      editorRows,
      rowsAfterEditor,
    )
  }

  getLayout(): ChatLayout | undefined {
    return this.layout
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

  setViewportRows(rows: number): void {
    const nextRows = Math.max(0, rows)
    this.viewportRows = nextRows
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.lineCount - nextRows))
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
  ) {
    super(higTui, theme, keybindings, options)
    this.higTui = higTui
    this.higKeybindings = keybindings
  }

  private readonly higTui: TUI
  private readonly higKeybindings: ConstructorParameters<typeof CustomEditor>[2]
  private chatViewport: ChatViewport | undefined
  private baseEditorCache: { width: number; state: string; lines: string[] } | undefined
  private emptyFaceLayout:
    | { markSpace: number; faceRows: number; top: number; bottom: number }
    | undefined

  setChatViewport(chatViewport: ChatViewport | undefined): void {
    this.chatViewport = chatViewport
  }

  getBaseEditorLines(width: number): string[] {
    const cursor = this.getCursor()
    const state = `${this.focused}:${this.getText()}:${cursor.line}:${cursor.col}`
    if (this.baseEditorCache?.width === width && this.baseEditorCache.state === state) {
      return this.baseEditorCache.lines
    }
    const lines = super.render(width)
    this.baseEditorCache = { width, state, lines }
    return lines
  }

  override invalidate(): void {
    this.baseEditorCache = undefined
    this.emptyFaceLayout = undefined
    super.invalidate()
  }

  override setText(text: string): void {
    this.baseEditorCache = undefined
    super.setText(text)
  }

  override setPaddingX(paddingX: number): void {
    this.baseEditorCache = undefined
    super.setPaddingX(paddingX)
  }

  override insertTextAtCursor(text: string): void {
    this.baseEditorCache = undefined
    super.insertTextAtCursor(text)
  }

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
    this.baseEditorCache = undefined
  }

  private fitEditorLines(lines: string[], height: number): string[] {
    if (height >= lines.length) return lines
    if (height <= 0) return []
    if (height === 1) return [lines[0]]
    return [lines[0], ...lines.slice(1, height - 1), lines[lines.length - 1]]
  }

  private getEmptyFaceLayout(markSpace: number, faceRows: number): { top: number; bottom: number } {
    if (
      this.emptyFaceLayout?.markSpace === markSpace &&
      this.emptyFaceLayout.faceRows === faceRows
    ) {
      return this.emptyFaceLayout
    }
    const [top, , bottom] = new FlexColumn([
      { basis: 0, grow: 1 },
      { basis: faceRows },
      { basis: 0, grow: 1 },
    ]).layout(markSpace)
    this.emptyFaceLayout = { markSpace, faceRows, top: top.size, bottom: bottom.size }
    return this.emptyFaceLayout
  }

  override render(width: number): string[] {
    const baseEditorLines = this.getBaseEditorLines(width)
    const layout = this.chatViewport?.getLayout()
    const editorSlot = layout?.slots.editor
    const editorLines = this.fitEditorLines(
      baseEditorLines,
      editorSlot?.size ?? baseEditorLines.length,
    )
    // terminal mouse coordinates are 1-based while render rows are 0-based.
    this.chatViewport?.setScreenTop(Math.max(0, (layout?.slots.chat.start ?? 0) - 1))
    const availableRows = Math.max(0, (editorSlot?.size ?? editorLines.length) - editorLines.length)

    // The agent-start render can happen before Pi appends the user message to
    // the session branch. Do not render the empty-state face while working, or
    // it temporarily expands the layout and pushes the editor into scrollback.
    let output: string[]
    if (hasConversation(this.ctx) || !this.ctx.isIdle()) {
      output = [...Array.from({ length: availableRows }, () => ""), ...editorLines]
    } else {
      const face = this.frameProvider()
      const visibleFace = face.slice(0, Math.min(face.length, availableRows))
      const markSpace = availableRows
      const { top, bottom } = this.getEmptyFaceLayout(markSpace, visibleFace.length)
      const mark = visibleFace.map((line) => {
        const greeting = line.replace(GREETING_TEXT, this.ctx.ui.theme.bold(GREETING_TEXT))
        const styled = this.ctx.ui.theme.fg("accent", greeting)
        if (width < FACE_WIDTH) return truncateToWidth(styled, width, "")
        const left = Math.floor((width - FACE_WIDTH) / 2)
        return `${" ".repeat(left)}${styled}${" ".repeat(width - left - FACE_WIDTH)}`
      })

      output = [
        ...Array.from({ length: top }, () => ""),
        ...mark,
        ...Array.from({ length: bottom }, () => ""),
        ...editorLines,
      ]
    }

    return output
  }
}

export default function hig(pi: ExtensionAPI): void {
  let inAlternateScreen = false
  let mouseTrackingEnabled = false
  let animationTimer: ReturnType<typeof setInterval> | undefined
  let requestRender: ((force?: boolean) => void) | undefined
  let removeTerminalInputListener: (() => void) | undefined
  let chatViewport: ChatViewport | undefined
  let mouseSelecting = false
  let copyFlashTimer: ReturnType<typeof setInterval> | undefined
  let restoreReservedStatus: (() => void) | undefined
  let frameIndex = 0

  process.once("exit", () => {
    if (removeTerminalInputListener) removeTerminalInputListener()
    if (mouseTrackingEnabled) process.stdout.write(MOUSE_OFF)
    if (inAlternateScreen) {
      leaveAlternateScreen()
      process.stdout.write(PRIMARY_TERMINAL_CLEAR)
    }
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
      requestRender = (force = false) => tui.requestRender(force)
      if (!restoreReservedStatus) {
        const statusContainer = tui.children[4] as RenderableContainer | undefined
        if (statusContainer) {
          restoreReservedStatus = reserveRows(statusContainer, 2, () => requestRender?.())
        }
      }
      chatViewport?.dispose()
      const flex = new HIGFlex()
      const editor = new HIGEditor(
        tui,
        editorTheme,
        keybindings,
        undefined,
        ctx,
        () => FACE_FRAMES[frameIndex],
      )
      const chatContainer = tui.children[2] as RenderableContainer | undefined
      chatViewport = chatContainer
        ? new ChatViewport(tui, chatContainer, editor, ctx.ui.theme, flex)
        : undefined
      editor.setChatViewport(chatViewport)
      return editor
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

  pi.on("agent_start", () => {
    requestRender?.(true)
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
    restoreReservedStatus?.()
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
    process.stdout.write(PRIMARY_TERMINAL_CLEAR)
  })
}
