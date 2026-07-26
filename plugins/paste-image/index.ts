import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ClipboardModule = typeof import("@mariozechner/clipboard");
type ImageContent = {
  type: "image";
  data: string;
  mimeType: "image/png";
};

const DEFAULT_MARKER = "[image attached]";
const WIDGET_KEY = "paste-image";

let clipboardPromise: Promise<ClipboardModule | undefined> | undefined;
let pendingImages: ImageContent[] = [];

async function getClipboard(): Promise<ClipboardModule | undefined> {
  clipboardPromise ??= import("@mariozechner/clipboard").catch(() => undefined);
  return clipboardPromise;
}

function updateAttachmentWidget(ctx: ExtensionContext): void {
  if (pendingImages.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }
  const count = pendingImages.length;
  ctx.ui.setWidget(WIDGET_KEY, [
    `📎 ${count} image${count === 1 ? "" : "s"} attached · keep typing, then press Enter to send`,
  ], { placement: "aboveEditor" });
}

function appendMarker(text: string): string {
  return text.length === 0 ? DEFAULT_MARKER : `${text} ${DEFAULT_MARKER}`;
}

function removeMarkers(text: string): string {
  return text.replaceAll(DEFAULT_MARKER, "").replace(/[ \t]+\n/g, "\n").trim();
}

async function readClipboardImage(): Promise<ImageContent | undefined> {
  const clipboard = await getClipboard();
  if (!clipboard || !clipboard.hasImage()) return undefined;

  const bytes = await clipboard.getImageBinary();
  if (bytes.length === 0) return undefined;

  return {
    type: "image",
    data: Buffer.from(bytes).toString("base64"),
    mimeType: "image/png",
  };
}

async function attachClipboardImage(ctx: ExtensionContext): Promise<boolean> {
  const image = await readClipboardImage();
  if (!image) return false;

  pendingImages.push(image);
  ctx.ui.setEditorText(appendMarker(ctx.ui.getEditorText()));
  updateAttachmentWidget(ctx);
  return true;
}

async function pasteTextFallback(ctx: ExtensionContext): Promise<void> {
  const clipboard = await getClipboard();
  if (!clipboard || !clipboard.hasText()) return;
  const text = await clipboard.getText();
  if (text) ctx.ui.pasteToEditor(text);
}

async function pasteOrAttach(ctx: ExtensionContext): Promise<void> {
  if (await attachClipboardImage(ctx)) return;
  await pasteTextFallback(ctx);
}

export default function pasteImage(pi: ExtensionAPI): void {
  // Replace pi's normal paste binding with an image-aware version. Text still
  // falls back to the normal editor paste; images become pending attachments.
  const shortcut = process.platform === "win32" ? "alt+v" : "ctrl+v";

  pi.registerShortcut(shortcut, {
    description: "Paste text or attach an image to the next prompt",
    handler: async (ctx) => {
      try {
        await pasteOrAttach(ctx);
      } catch (error) {
        ctx.ui.notify(`Clipboard paste failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("paste-image", {
    description: "Attach the image currently in the clipboard to the next prompt",
    handler: async (_args, ctx) => {
      try {
        if (!(await attachClipboardImage(ctx))) {
          ctx.ui.notify("No image found in the clipboard.", "warning");
        }
      } catch (error) {
        ctx.ui.notify(`Clipboard image failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("input", (event, ctx) => {
    if (pendingImages.length === 0) return { action: "continue" as const };

    const images = pendingImages;
    pendingImages = [];
    updateAttachmentWidget(ctx);
    return {
      action: "transform" as const,
      text: removeMarkers(event.text),
      images: [...(event.images ?? []), ...images],
    };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    pendingImages = [];
    updateAttachmentWidget(ctx);
  });
}
