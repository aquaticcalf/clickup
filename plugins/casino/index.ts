import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const THEME_NAME = "casino";
const STATUS_KEY = "casino-mode";
const WIDGET_KEY = "casino-mode-widget";
const SUIT_FRAMES = ["♠ ♥ ♦ ♣", "♥ ♦ ♣ ♠", "♦ ♣ ♠ ♥", "♣ ♠ ♥ ♦"];

export default function casino(pi: ExtensionAPI): void {
  let enabled = false;
  let previousTheme: ReturnType<ExtensionContext["ui"]["getTheme"]> | undefined;
  let animation: ReturnType<typeof setInterval> | undefined;

  const clearVisuals = (ctx: ExtensionContext): void => {
    if (animation) {
      clearInterval(animation);
      animation = undefined;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setWorkingIndicator();
    }
  };

  const disable = (ctx: ExtensionContext): void => {
    clearVisuals(ctx);
    if (previousTheme) ctx.ui.setTheme(previousTheme);
    previousTheme = undefined;
    enabled = false;
  };

  const renderVisuals = (ctx: ExtensionContext, frameIndex: number): void => {
    const frame = SUIT_FRAMES[frameIndex % SUIT_FRAMES.length];
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", `🎰 CASINO MODE ${frame}`));

    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, [
        theme.fg("accent", `╔══ ${frame} ══╗`),
        theme.fg("warning", "║  HIGH-STAKES CODE GENERATION  ║"),
        theme.fg("accent", "╚══════════════════════════════╝"),
      ]);
    }
  };

  const enable = (ctx: ExtensionContext): boolean => {
    const originalTheme = ctx.ui.theme;
    const result = ctx.ui.setTheme(THEME_NAME);
    if (!result.success) {
      ctx.ui.notify(`Could not enable Casino Mode: ${result.error ?? "theme unavailable"}`, "error");
      return false;
    }

    previousTheme = previousTheme ?? originalTheme;
    enabled = true;

    if (ctx.mode === "tui") {
      ctx.ui.setWorkingIndicator({
        frames: SUIT_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
        intervalMs: 160,
      });
    }

    let frameIndex = 0;
    renderVisuals(ctx, frameIndex);
    animation = setInterval(() => {
      frameIndex += 1;
      renderVisuals(ctx, frameIndex);
    }, 420);
    return true;
  };

  pi.registerCommand("casino", {
    description: "Toggle the neon casino visual theme",
    handler: async (_args, ctx) => {
      if (enabled) {
        disable(ctx);
        ctx.ui.notify("Casino Mode off. House lights restored.", "info");
      } else if (enable(ctx)) {
        ctx.ui.notify("Casino Mode on. Place your bets on the next generation.", "info");
      }
    },
  });

  pi.on("session_start", () => {
    enabled = false;
    previousTheme = undefined;
    animation = undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (enabled) disable(ctx);
    else clearVisuals(ctx);
  });
}
