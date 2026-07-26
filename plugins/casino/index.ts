import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const THEME_NAME = "casino";
const STATUS_KEY = "casino-mode";
const SUITS = ["♠", "♥", "♦", "♣"];
const REDUCED_MOTION = /^(1|true|yes)$/i.test(process.env.CASINO_REDUCED_MOTION ?? "");

type Theme = ReturnType<ExtensionContext["ui"]["getTheme"]>;

export default function casino(pi: ExtensionAPI): void {
  let enabled = false;
  let previousTheme: Theme | undefined;

  const clearVisuals = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (ctx.mode === "tui") ctx.ui.setWorkingIndicator();
  };

  const disable = (ctx: ExtensionContext): void => {
    clearVisuals(ctx);
    if (previousTheme) ctx.ui.setTheme(previousTheme);
    previousTheme = undefined;
    enabled = false;
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "CASINO · ON  ♦"));
  };

  const enable = (ctx: ExtensionContext): boolean => {
    const originalTheme = ctx.ui.theme;
    const result = ctx.ui.setTheme(THEME_NAME);
    if (!result.success) {
      ctx.ui.notify(`Could not enable Casino Mode: ${result.error ?? "theme unavailable"}`, "error");
      return false;
    }

    previousTheme = originalTheme;
    enabled = true;
    updateStatus(ctx);

    if (ctx.mode === "tui") {
      const frames = REDUCED_MOTION
        ? [ctx.ui.theme.fg("accent", "♦")]
        : SUITS.map((suit) => ctx.ui.theme.fg("accent", suit));
      ctx.ui.setWorkingIndicator({ frames, intervalMs: REDUCED_MOTION ? 1000 : 650 });
    }
    return true;
  };

  pi.registerCommand("casino", {
    description: "Toggle the refined casino visual theme",
    handler: async (_args, ctx) => {
      if (enabled) {
        disable(ctx);
        ctx.ui.notify("Casino mode off", "info");
      } else if (enable(ctx)) {
        ctx.ui.notify("Casino mode on", "info");
      }
    },
  });

  pi.on("session_start", () => {
    enabled = false;
    previousTheme = undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (enabled) disable(ctx);
    else clearVisuals(ctx);
  });
}
