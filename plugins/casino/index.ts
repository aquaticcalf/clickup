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
  let statusResetTimer: ReturnType<typeof setTimeout> | undefined;
  const sounds = new SoundEngine();

  const clearVisuals = (ctx: ExtensionContext): void => {
    if (statusResetTimer) clearTimeout(statusResetTimer);
    statusResetTimer = undefined;
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
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "CASINO · READY  ♦"));
  };

  const pulseStatus = (
    ctx: ExtensionContext,
    text: string,
    color: "accent" | "success" | "error" | "warning",
    durationMs: number,
  ): void => {
    if (!enabled) return;
    if (statusResetTimer) clearTimeout(statusResetTimer);
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `CASINO · ${text}`));
    statusResetTimer = setTimeout(() => {
      statusResetTimer = undefined;
      if (enabled) updateStatus(ctx);
    }, durationMs);
  };

  const setCasinoHeader = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        const mark = theme.fg("accent", "♦");
        const name = theme.bold(theme.fg("accent", "CASINO"));
        const subtitle = theme.fg("muted", " · private table · low noise");
        return [truncateToWidth(`  ${mark} ${name}${subtitle}`, width, "")];
      },
      invalidate(): void {},
    }));
  };

  const enable = (ctx: ExtensionContext): boolean => {
    const originalTheme = ctx.ui.theme;
    const casinoTheme = ctx.ui.getTheme(THEME_NAME);
    if (!casinoTheme) {
      ctx.ui.notify("Could not enable Casino Mode: theme unavailable", "error");
      return false;
    }
    // Pass the Theme object, not the name: pi persists named theme selections.
    const result = ctx.ui.setTheme(casinoTheme);
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
      } else {
        enable(ctx);
      }
    },
  });

  pi.on("agent_start", (_event, ctx) => {
    if (enabled) {
      sounds.play("agentStart");
      pulseStatus(ctx, "DEALING  ♦", "accent", 900);
    }
  });

  pi.on("tool_execution_start", () => {
    if (enabled) sounds.play("toolStart");
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!enabled) return;
    sounds.play(event.isError ? "toolError" : "toolSuccess");
    pulseStatus(ctx, event.isError ? "BUST  ♠" : "HIT  ♥", event.isError ? "error" : "success", 550);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (enabled) {
      sounds.play("turnEnd");
      pulseStatus(ctx, "HAND CLOSED  ♣", "accent", 850);
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (enabled) {
      sounds.play("settled");
      pulseStatus(ctx, "PAYOUT  ♦", "success", 1000);
    }
  });

  pi.on("session_start", () => {
    enabled = false;
    previousTheme = undefined;
    if (statusResetTimer) clearTimeout(statusResetTimer);
    statusResetTimer = undefined;
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
