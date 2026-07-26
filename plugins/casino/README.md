# Casino Mode

A restrained casino-lounge visual theme for pi. It is optional and off by default.

## Command

```text
/casino
```

`/casino` toggles the mode on and off.

When enabled, it applies a high-contrast dark theme with gold as the primary accent and muted teal/rose secondary colors across Pi's built-in interface: messages, tools, diffs, Markdown, syntax highlighting, thinking levels, borders, and status colors.

The only persistent decoration is a compact `CASINO · ON ♦` status indicator. During model work, the normal working indicator uses a subtle card-suit cycle. No banner or animated widget is added.

When toggled off, the indicator and working animation are cleared and the exact previous theme is restored.

Set `CASINO_REDUCED_MOTION=1` to use a static working indicator.

Casino Mode changes UI state only. It does not change the system prompt, tools, conversation, or model/provider cache.
