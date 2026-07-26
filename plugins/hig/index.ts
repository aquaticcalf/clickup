import { userInfo } from "node:os";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const THEME_NAME = "hig";
const ALT_SCREEN_ON = "\u001b[?1049h\u001b[2J\u001b[H";
const ALT_SCREEN_OFF = "\u001b[?1049l";
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

class HIGEditor extends CustomEditor {
  constructor(
    higTui: TUI,
    theme: EditorTheme,
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    options: EditorOptions | undefined,
    private readonly ctx: ExtensionContext,
    private readonly frameProvider: () => string[],
  ) {
    super(higTui, theme, keybindings, options);
    this.higTui = higTui;
  }

  private readonly higTui: TUI;

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
    const availableRows = Math.max(
      0,
      this.higTui.terminal.rows - rowsBeforeEditor - rowsAfterEditor - editorLines.length,
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
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  let frameIndex = 0;

  process.once("exit", () => {
    if (inAlternateScreen) leaveAlternateScreen();
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    inAlternateScreen = enterAlternateScreen();
    const theme = ctx.ui.getTheme(THEME_NAME);
    if (theme) ctx.ui.setTheme(theme);

    frameIndex = 0;
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      requestRender = () => tui.requestRender();
      return new HIGEditor(
        tui,
        editorTheme,
        keybindings,
        undefined,
        ctx,
        () => FACE_FRAMES[frameIndex],
      );
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
    animationTimer = undefined;
    requestRender = undefined;
    ctx.ui.setEditorComponent(undefined);
    if (inAlternateScreen) {
      leaveAlternateScreen();
      inAlternateScreen = false;
    }
  });
}
