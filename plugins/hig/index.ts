import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";

const THEME_NAME = "hig";
const ALT_SCREEN_ON = "\u001b[?1049h\u001b[2J\u001b[H";
const ALT_SCREEN_OFF = "\u001b[?1049l";
const FOOTER_ROWS = 3;
const DEFAULT_WIDGET_ROWS = 1;
const PI_MARK = [
  "  ████████████████████████  ",
  "  ██                      ██  ",
  "  ██                      ██  ",
  "  ██                      ██  ",
  "  ██                      ██  ",
  "  ██                      ██  ",
  "  ██                      ██  ",
];

type Theme = ReturnType<ExtensionContext["ui"]["getTheme"]>;

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
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    options: EditorOptions | undefined,
    private readonly ctx: ExtensionContext,
  ) {
    super(tui, theme, keybindings, options);
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
    const mark = PI_MARK.map((line) => this.ctx.ui.theme.fg("accent", line));

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
