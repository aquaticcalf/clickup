import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const THEME_NAME = "hig";

type Theme = ReturnType<ExtensionContext["ui"]["getTheme"]>;

export default function hig(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const theme: Theme = ctx.ui.getTheme(THEME_NAME);
    if (theme) ctx.ui.setTheme(theme);
  });
}
