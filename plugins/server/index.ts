import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import * as QRCode from "qrcode";
import { ServerManager } from "./manager.ts";

function statusText(status: Awaited<ReturnType<ServerManager["status"]>>): string {
  if (!status.running) return `Pi host: stopped${status.enabled ? " (automatic startup enabled)" : ""}`;
  return `Pi host: running at ${status.url}${status.pid ? ` (pid ${status.pid})` : ""}${status.enabled ? " (automatic startup enabled)" : ""}`;
}

async function showPairingQr(ctx: ExtensionCommandContext, payload: string, endpoint: string): Promise<void> {
  if (!payload) return;

  const qr = await QRCode.toString(payload, {
    type: "utf8",
    errorCorrectionLevel: "M",
  });
  const qrWidth = Math.max(...qr.trimEnd().split("\n").map((line) => visibleWidth(line)));

  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(`Pi host started at ${endpoint}, but the pairing QR requires TUI mode.`, "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold("Pi host pairing")), 1, 0));
    container.addChild(new Text(theme.fg("muted", "Scan this QR code with the mobile app."), 1, 0));
    container.addChild(new Text(qr.trimEnd(), 1, 0));
    container.addChild(new Text(theme.fg("dim", `${endpoint} • Enter or Escape to close`), 1, 0));

    return {
      render: (width: number) => container.render(width),
      handleInput: (data: string) => {
        if (data === "\r" || data === "\n" || data === "\u001b") done();
        else tui.requestRender();
      },
      invalidate: () => container.invalidate(),
    };
  }, {
    overlay: true,
    overlayOptions: {
      width: qrWidth + 4,
      margin: 1,
    },
  });
}

export default function serverPlugin(pi: ExtensionAPI): void {
  const manager = new ServerManager();

  const refreshStatus = async (): Promise<Awaited<ReturnType<ServerManager["status"]>>> =>
    manager.status();

  pi.registerCommand("server", {
    description: "Start, stop, or inspect the background pi host server",
    handler: async (args, ctx) => {
      const command = args.trim().split(/\s+/, 1)[0]?.toLowerCase() || "status";

      try {
        if (command === "start") {
          if (!(await manager.hasEntrypoint())) {
            ctx.ui.notify("Pi host server files are not available in this installation.", "error");
            return;
          }

          const result = await manager.start();
          if (!result.pairingPayload) {
            ctx.ui.notify(`Pi host is already running at ${result.status.url}.`, "info");
            return;
          }

          const storage = result.credentialStored
            ? "The new auth token was stored in the operating-system credential store."
            : "The new auth token could not be stored and is only available for this Pi process.";
          ctx.ui.notify(`Pi host started at ${result.status.url}. ${storage}`, "info");
          await showPairingQr(ctx, result.pairingPayload, result.status.url);
          return;
        }

        if (command === "enable") {
          if (!(await manager.hasEntrypoint())) {
            ctx.ui.notify("Pi host server files are not available in this installation.", "error");
            return;
          }

          const result = await manager.enable();
          if (result.pairingPayload) await showPairingQr(ctx, result.pairingPayload, result.status.url);
          ctx.ui.notify("Pi host enabled and configured to start automatically.", "info");
          return;
        }

        if (command === "disable" || command === "stop") {
          const stopped = await manager.stop();
          ctx.ui.notify(
            stopped ? "Pi host stopped and automatic startup disabled." : "Pi host was not running.",
            "info",
          );
          return;
        }

        if (command === "logout") {
          await manager.stop();
          const deleted = await manager.logout();
          ctx.ui.notify(
            deleted ? "Pi host stopped and its saved auth token was deleted." : "No saved Pi host auth token was found.",
            "info",
          );
          return;
        }

        if (command !== "status") {
          ctx.ui.notify("Usage: /server start | enable | stop | disable | status | logout", "warning");
          return;
        }

        const status = await refreshStatus();
        ctx.ui.notify(
          `${statusText(status)}\nOpenAPI: ${status.url}/openapi\nState: ${status.stateFile}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Pi host operation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
