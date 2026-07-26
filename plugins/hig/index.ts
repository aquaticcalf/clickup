import { userInfo } from "node:os";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const THEME_NAME = "hig";
const ALT_SCREEN_ON = "\u001b[?1049h\u001b[2J\u001b[H";
const ALT_SCREEN_OFF = "\u001b[?1049l";
const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1000l\u001b[?1006l";
const FACE_WIDTH = 45;
const FACE_HEIGHT = 14;
const REDUCED_MOTION = /^(1|true|yes)$/i.test(process.env.HIG_REDUCED_MOTION ?? "");

function getUserName(): string {
  try {
    return userInfo().username.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  } catch {
    return "";
  }
}

const USER_NAME = getUserName();
const GREETING_TEXT = USER_NAME ? `hi, ${USER_NAME}` : "hi";

function buildCuteFrame(expression: string): string[] {
  const rows = Array.from({ length: FACE_HEIGHT }, () => " ".repeat(FACE_WIDTH));

  const put = (text: string, row: number): void => {
    const fitted = truncateToWidth(text, FACE_WIDTH, "");
    const textWidth = visibleWidth(fitted);
    const start = Math.max(0, Math.floor((FACE_WIDTH - textWidth) / 2));
    const right = Math.max(0, FACE_WIDTH - start - textWidth);
    rows[row] = " ".repeat(start) + fitted + " ".repeat(right);
  };

  put(`*:･ﾟ✧*:･ﾟ✧ ${GREETING_TEXT} ${expression} ✧ﾟ･: *✧ﾟ･:*`, 6);
  put("♡ ( =^･ω･^= ) ♡", 8);

  return rows;
}

const FACE_FRAMES = [
  buildCuteFrame(">_<"),
  buildCuteFrame(">_>"),
  buildCuteFrame(">_<"),
  buildCuteFrame("U_U"),
];

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

function enterAlternateScreen(): boolean {
  if (!isInteractiveTerminal()) return false;
  process.stdout.write(ALT_SCREEN_ON);
  return true;
}

function leaveAlternateScreen(): void {
  if (!isInteractiveTerminal()) return;
  process.stdout.write(ALT_SCREEN_OFF);
}

function hasConversation(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
}

function getComponentChildren(component: unknown): unknown[] | undefined {
  if (typeof component !== "object" || component === null || !("children" in component)) {
    return undefined;
  }
  const children = (component as { children?: unknown }).children;
  return Array.isArray(children) ? children : undefined;
}

type RenderableContainer = {
  render(width: number): string[];
};

/**
 * The core TUI keeps the editor focused and renders the whole conversation above
 * it. Give the conversation its own viewport so wheel/page scrolling never
 * reaches CustomEditor (where Up/Down correctly mean prompt history).
 */
class ChatViewport {
  private readonly originalRender: (width: number) => string[];
  private viewportRows = 0;
  private visibleRows = 0;
  private lineCount = 0;
  private scrollOffset = 0;

  constructor(private readonly container: RenderableContainer) {
    this.originalRender = container.render.bind(container);
    container.render = (width: number): string[] => {
      const lines = this.originalRender(width);
      this.lineCount = lines.length;
      const rows = this.viewportRows > 0 ? this.viewportRows : lines.length;
      const maxOffset = Math.max(0, lines.length - rows);
      this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
      const end = Math.max(0, lines.length - this.scrollOffset);
      const start = Math.max(0, end - rows);
      const visible = lines.slice(start, end);
      this.visibleRows = visible.length;
      return visible;
    };
  }

  getVisibleRows(): number {
    return this.visibleRows;
  }

  setViewportRows(rows: number): boolean {
    const nextRows = Math.max(0, rows);
    const changed = this.viewportRows !== nextRows;
    this.viewportRows = nextRows;
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.lineCount - nextRows));
    return changed;
  }

  scrollBy(lines: number): boolean {
    const maxOffset = Math.max(0, this.lineCount - this.viewportRows);
    const nextOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + lines));
    if (nextOffset === this.scrollOffset) return false;
    this.scrollOffset = nextOffset;
    return true;
  }

  dispose(): void {
    this.container.render = this.originalRender;
  }
}

function parseMouseWheel(data: string): number {
  const sgr = data.match(/^\u001b\[<(\d+);\d+;\d+[mM]$/);
  if (sgr) {
    const button = Number.parseInt(sgr[1], 10);
    if ((button & 64) === 0) return 0;
    return (button & 1) === 0 ? 3 : -3;
  }

  // Legacy X10 mouse encoding: ESC [ M button x y.
  if (data.startsWith("\u001b[M") && data.length >= 6) {
    const button = data.charCodeAt(3) - 32;
    if ((button & 64) === 0) return 0;
    return (button & 1) === 0 ? 3 : -3;
  }
  return 0;
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
    super(higTui, theme, keybindings, options);
    this.higTui = higTui;
    this.higKeybindings = keybindings;
  }

  private readonly higTui: TUI;
  private readonly higKeybindings: ConstructorParameters<typeof CustomEditor>[2];

  override handleInput(data: string): void {
    if (this.chatViewport && this.higKeybindings.matches(data, "tui.editor.pageUp")) {
      if (this.chatViewport.scrollBy(3)) this.higTui.requestRender();
      return;
    }
    if (this.chatViewport && this.higKeybindings.matches(data, "tui.editor.pageDown")) {
      if (this.chatViewport.scrollBy(-3)) this.higTui.requestRender();
      return;
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const editorLines = super.render(width);
    const editorContainerIndex = this.higTui.children.findIndex((child) =>
      getComponentChildren(child)?.includes(this),
    );
    const rowsBeforeEditor = editorContainerIndex < 0
      ? 0
      : this.higTui.children
          .slice(0, editorContainerIndex)
          .reduce((rows, child) => rows + child.render(width).length, 0);
    const rowsAfterEditor = editorContainerIndex < 0
      ? 0
      : this.higTui.children
          .slice(editorContainerIndex + 1)
          .reduce((rows, child) => rows + child.render(width).length, 0);
    const rowsBeforeChat = this.chatViewport
      ? Math.max(0, rowsBeforeEditor - this.chatViewport.getVisibleRows())
      : rowsBeforeEditor;
    const desiredChatRows = Math.max(
      0,
      this.higTui.terminal.rows - rowsBeforeChat - rowsAfterEditor - editorLines.length,
    );
    if (this.chatViewport?.setViewportRows(desiredChatRows)) {
      this.higTui.requestRender();
    }
    const adjustedRowsBeforeEditor = rowsBeforeChat + (this.chatViewport?.getVisibleRows() ?? 0);
    const availableRows = Math.max(
      0,
      this.higTui.terminal.rows - adjustedRowsBeforeEditor - rowsAfterEditor - editorLines.length,
    );

    if (hasConversation(this.ctx)) {
      return [...Array.from({ length: availableRows }, () => ""), ...editorLines];
    }

    const face = this.frameProvider();
    const markSpace = Math.max(face.length, availableRows);
    const topSpace = Math.max(0, Math.floor((markSpace - face.length) / 2));
    const bottomSpace = Math.max(0, markSpace - topSpace - face.length);
    const mark = face.map((line) => {
      const greeting = line.replace(GREETING_TEXT, this.ctx.ui.theme.bold(GREETING_TEXT));
      const styled = this.ctx.ui.theme.fg("accent", greeting);
      if (width < FACE_WIDTH) return truncateToWidth(styled, width, "");
      const left = Math.floor((width - FACE_WIDTH) / 2);
      return `${" ".repeat(left)}${styled}${" ".repeat(width - left - FACE_WIDTH)}`;
    });

    return [
      ...Array.from({ length: topSpace }, () => ""),
      ...mark,
      ...Array.from({ length: bottomSpace }, () => ""),
      ...editorLines,
    ];
  }
}

export default function hig(pi: ExtensionAPI): void {
  let inAlternateScreen = false;
  let mouseTrackingEnabled = false;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  let removeTerminalInputListener: (() => void) | undefined;
  let chatViewport: ChatViewport | undefined;
  let frameIndex = 0;

  process.once("exit", () => {
    if (removeTerminalInputListener) removeTerminalInputListener();
    if (mouseTrackingEnabled) process.stdout.write(MOUSE_OFF);
    if (inAlternateScreen) leaveAlternateScreen();
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    inAlternateScreen = enterAlternateScreen();
    mouseTrackingEnabled = isInteractiveTerminal();
    if (mouseTrackingEnabled) process.stdout.write(MOUSE_ON);
    const theme = ctx.ui.getTheme(THEME_NAME);
    if (theme) ctx.ui.setTheme(theme);

    frameIndex = 0;
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      requestRender = () => tui.requestRender();
      const chatContainer = tui.children[2] as RenderableContainer | undefined;
      chatViewport?.dispose();
      chatViewport = chatContainer ? new ChatViewport(chatContainer) : undefined;
      return new HIGEditor(
        tui,
        editorTheme,
        keybindings,
        undefined,
        ctx,
        () => FACE_FRAMES[frameIndex],
        chatViewport,
      );
    });

    removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
      const scroll = parseMouseWheel(data);
      if (scroll === 0 || !chatViewport) return undefined;
      if (chatViewport.scrollBy(scroll)) requestRender?.();
      return { consume: true };
    });

    if (!REDUCED_MOTION) {
      animationTimer = setInterval(() => {
        if (!hasConversation(ctx)) {
          frameIndex = (frameIndex + 1) % FACE_FRAMES.length;
          requestRender?.();
        }
      }, 750);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (animationTimer) clearInterval(animationTimer);
    removeTerminalInputListener?.();
    removeTerminalInputListener = undefined;
    chatViewport?.dispose();
    chatViewport = undefined;
    if (mouseTrackingEnabled) process.stdout.write(MOUSE_OFF);
    mouseTrackingEnabled = false;
    animationTimer = undefined;
    requestRender = undefined;
    ctx.ui.setEditorComponent(undefined);
    if (inAlternateScreen) {
      leaveAlternateScreen();
      inAlternateScreen = false;
    }
  });
}
