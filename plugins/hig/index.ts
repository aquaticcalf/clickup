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
  const left = 6;
  const right = PI_GLYPH_WIDTH - left - 1;

  // Terminal glyphs form the actual lowercase mathematical π: a straight
  // overbar with two descending stems. No box, arch, or decorative enclosure.
  for (let x = left; x <= right; x += 1) rows[0][x] = "━";
  for (let y = 1; y < PI_GLYPH_HEIGHT; y += 1) {
    rows[y][left] = "┃";
    rows[y][right] = "┃";
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

function estimateConversationRows(ctx: ExtensionContext, width: number): number {
  const contentWidth = Math.max(24, width - 8);
  let rows = 0;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const content = "content" in entry.message ? entry.message.content : "";
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => {
            if (typeof part === "string") return part;
            if (typeof part === "object" && part !== null && "text" in part) {
              return typeof part.text === "string" ? part.text : "";
            }
            return "";
          }).join(" ")
        : "";
    rows += Math.max(1, Math.ceil(text.length / contentWidth)) + 2;
  }

  return rows;
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
    const conversationRows = estimateConversationRows(this.ctx, width);
    const available = Math.max(
      0,
      this.tui.terminal.rows - editorLines.length - FOOTER_ROWS - DEFAULT_WIDGET_ROWS - conversationRows,
    );
    const emptyLine = "";

    // Keep the editor/footer at the bottom even after the empty-state mark
    // disappears. When there is no chat, use that same space for the centered
    // mark; when chat exists, use it as quiet breathing room below the chat.
    if (hasConversation(this.ctx)) {
      return [...Array.from({ length: available }, () => emptyLine), ...editorLines];
    }

    const markSpace = Math.max(PI_MARK.length, available);
    const topSpace = Math.max(0, Math.floor((markSpace - PI_MARK.length) / 2));
    const bottomSpace = Math.max(0, markSpace - topSpace - PI_MARK.length);
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
