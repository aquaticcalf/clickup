import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const THEME_NAME = "hig";
const EMPTY_STATE_KEY = "hig-empty-state";
const ALT_SCREEN_ON = "\u001b[?1049h\u001b[2J\u001b[H";
const ALT_SCREEN_OFF = "\u001b[?1049l";
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

function setEmptyState(ctx: ExtensionContext): void {
  ctx.ui.setWidget(EMPTY_STATE_KEY, (_tui, theme) => ({
    render(width: number): string[] {
      if (ctx.ui.getEditorText().trim() || hasConversation(ctx)) return [];

      return PI_MARK.map((line) => {
        const left = Math.max(0, Math.floor((width - line.length) / 2));
        return `${" ".repeat(left)}${theme.fg("accent", line)}`;
      });
    },
    invalidate(): void {},
  }));
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
    setEmptyState(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(EMPTY_STATE_KEY, undefined);
    if (inAlternateScreen) {
      leaveAlternateScreen();
      inAlternateScreen = false;
    }
  });
}
