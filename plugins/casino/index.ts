import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { SoundEngine } from "./audio/sound-engine.ts";

const THEME_NAME = "casino";
const STATUS_KEY = "casino-mode";
const SUITS = ["♠", "♥", "♦", "♣"];
const REDUCED_MOTION = /^(1|true|yes)$/i.test(process.env.CASINO_REDUCED_MOTION ?? "");

type Theme = ReturnType<ExtensionContext["ui"]["getTheme"]>;

export default function casino(pi: ExtensionAPI): void {
  let enabled = false;
  let previousTheme: Theme | undefined;
  const sounds = new SoundEngine();

  const clearVisuals = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (ctx.mode === "tui") {
      ctx.ui.setWorkingIndicator();
      ctx.ui.setHeader(undefined);
    }
  };

  const disable = (ctx: ExtensionContext): void => {
    sounds.play("off");
    void sounds.disableAfterQueuedSounds();
    clearVisuals(ctx);
    if (previousTheme) ctx.ui.setTheme(previousTheme);
    previousTheme = undefined;
    enabled = false;
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "CASINO · ON  ♦"));
  };

  const setCasinoHeader = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        const mark = theme.fg("accent", "♦");
        const name = theme.bold(theme.fg("accent", "CASINO"));
        const subtitle = theme.fg("muted", " · high-stakes code, low noise");
        return [truncateToWidth(`  ${mark} ${name}${subtitle}`, width, "")];
      },
      invalidate(): void {},
    }));
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
    sounds.enable();
    sounds.play("on");
    setCasinoHeader(ctx);
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
    description: "Toggle the refined casino visual theme and soundscape",
    handler: async (_args, ctx) => {
      if (enabled) {
        disable(ctx);
        ctx.ui.notify("Casino mode off", "info");
      } else if (enable(ctx)) {
        ctx.ui.notify("Casino mode on", "info");
      }
    },
  });

  pi.on("agent_start", () => {
    if (enabled) sounds.play("agentStart");
  });

  pi.on("tool_execution_start", () => {
    if (enabled) sounds.play("toolStart");
  });

  pi.on("tool_execution_end", (event) => {
    if (enabled) sounds.play(event.isError ? "toolError" : "toolSuccess");
  });

  pi.on("turn_end", () => {
    if (enabled) sounds.play("turnEnd");
  });

  pi.on("agent_settled", () => {
    if (enabled) sounds.play("settled");
  });

  pi.on("session_start", () => {
    enabled = false;
    previousTheme = undefined;
    sounds.stopImmediately();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (enabled) {
      sounds.stopImmediately();
      clearVisuals(ctx);
      if (previousTheme) ctx.ui.setTheme(previousTheme);
      enabled = false;
      previousTheme = undefined;
    } else {
      clearVisuals(ctx);
    }
  });
}
