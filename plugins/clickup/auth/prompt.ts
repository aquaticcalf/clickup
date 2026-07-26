import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, Input, Text, truncateToWidth } from "@earendil-works/pi-tui"

export async function promptForApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined

  if (ctx.mode !== "tui") {
    const value = await ctx.ui.input("ClickUp API key", "Paste your ClickUp personal/API token")
    return value?.trim() || undefined
  }

  const value = await ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => {
      const input = new Input()
      const container = new Container()

      input.onSubmit = (submitted) => done(submitted.trim() || null)
      input.onEscape = () => done(null)

      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text(theme.fg("accent", theme.bold("ClickUp authentication")), 1, 0))
      container.addChild(
        new Text(
          theme.fg(
            "muted",
            "Paste your ClickUp API key. It will not be shown or sent to the model.",
          ),
          1,
          0,
        ),
      )
      const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
      container.addChild({
        render(width: number): string[] {
          const masked = "•".repeat(Array.from(graphemeSegmenter.segment(input.getValue())).length)
          return [truncateToWidth(`  ${masked}${masked ? " " : "▏"}`, width, "")]
        },
        invalidate(): void {},
      })
      container.addChild(new Text(theme.fg("dim", "Enter to save • Escape to cancel"), 1, 0))
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

      return {
        render: (width: number) => container.render(width),
        handleInput: (data: string) => {
          input.handleInput(data)
          tui.requestRender()
        },
        invalidate: () => container.invalidate(),
      }
    },
    { overlay: true },
  )

  return value ?? undefined
}
