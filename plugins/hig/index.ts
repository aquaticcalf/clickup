import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";

const THEME_NAME = "hig";
const ALT_SCREEN_ON = "\u001b[?1049h\u001b[2J\u001b[H";
const ALT_SCREEN_OFF = "\u001b[?1049l";
const FOOTER_ROWS = 3;
const DEFAULT_WIDGET_ROWS = 1;
const PI_GLYPH_WIDTH = 31;
const PI_GLYPH_HEIGHT = 9;

type Theme = ReturnType<ExtensionContext["ui"]["getTheme"]>;

function buildPiAscii(): string[] {
  const rows = Array.from({ length: PI_GLYPH_HEIGHT }, () => Array(PI_GLYPH_WIDTH).fill(" "));
  const left = 5;
  const right = PI_GLYPH_WIDTH - left - 1;

  // A heavy, symmetrical lowercase-style pi: a double crossbar and two stems.
  for (let y = 0; y < 2; y += 1) {
    for (let x = left; x <= right; x += 1) rows[y][x] = "#";
  }
  for (let y = 2; y < PI_GLYPH_HEIGHT; y += 1) {
    for (let x = left; x < left + 3; x += 1) rows[y][x] = "#";
    for (let x = right - 2; x <= right; x += 1) rows[y][x] = "#";
  }

  return rows.map((row) => row.join(""));
}

const PI_MARK = buildPiAscii();

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

class HIGEditor extends CustomEditor {
  private readonly ctx: ExtensionContext;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    options: EditorOptions | undefined,
    ctx: ExtensionContext,
  ) {
    super(tui, theme, keybindings, options);
    this.ctx = ctx;
  }

  override render(width: number): string[] {
    const editorLines = super.render(width);
    if (hasConversation(this.ctx)) return editorLines;

    // The core TUI keeps the viewport bottom-aligned. Reserve the remaining
    // viewport here so the editor/footer stay at the bottom like a full-height
    // web app, while the empty-state mark can sit in the visual center.
    const available = Math.max(
      PI_MARK.length,
      this.tui.terminal.rows - editorLines.length - FOOTER_ROWS - DEFAULT_WIDGET_ROWS,
    );
    const topSpace = Math.max(0, Math.floor((available - PI_MARK.length) / 2));
    const bottomSpace = Math.max(0, available - topSpace - PI_MARK.length);
    const emptyLine = "";
    const viewportWidth = Math.max(width, this.tui.terminal.columns, PI_GLYPH_WIDTH);
    const markLeft = Math.floor((viewportWidth - PI_GLYPH_WIDTH) / 2);
    const mark = PI_MARK.map((line) => {
      const right = Math.max(0, viewportWidth - markLeft - PI_GLYPH_WIDTH);
      return `${" ".repeat(markLeft)}${this.ctx.ui.theme.fg("accent", line)}${" ".repeat(right)}`;
    });

    return [
      ...Array.from({ length: topSpace }, () => emptyLine),
      ...mark,
      ...Array.from({ length: bottomSpace }, () => emptyLine),
      ...editorLines,
    ];
  }
}

export default function hig(pi: ExtensionAPI): void {
  let inAlternateScreen = false;

  process.once("exit", () => {
    if (inAlternateScreen) leaveAlternateScreen();
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    inAlternateScreen = enterAlternateScreen();
    const theme: Theme = ctx.ui.getTheme(THEME_NAME);
    if (theme) ctx.ui.setTheme(theme);

    ctx.ui.setWidget("hig-empty-state", undefined);
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
      new HIGEditor(tui, editorTheme, keybindings, undefined, ctx),
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(undefined);
    if (inAlternateScreen) {
      leaveAlternateScreen();
      inAlternateScreen = false;
    }
  });
}
