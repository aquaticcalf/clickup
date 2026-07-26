# Casino Mode

A restrained casino-lounge visual theme for pi. It is optional and off by default.

## Command

```text
/casino
```

`/casino` toggles the mode on and off.

When enabled, it applies a high-contrast dark theme with gold as the primary accent and muted teal/rose secondary colors across Pi's built-in interface: messages, tools, diffs, Markdown, syntax highlighting, thinking levels, borders, and status colors. The normal prompt border uses gold, while shell mode uses teal so the two states are immediately distinguishable.

The Pi header is replaced by a compact Casino wordmark. The persistent status is `CASINO · READY ♦`; short, bounded status pulses such as `DEALING`, `HIT`, `BUST`, `HAND CLOSED`, and `PAYOUT` provide anticipation and outcome feedback without adding a banner or a continuously animated widget. During model work, the normal working indicator uses a subtle card-suit cycle.

When toggled off, the indicator, status pulses, and working animation are cleared and the exact previous theme is restored.

Set `CASINO_REDUCED_MOTION=1` to use a static working indicator.

## Soundscape

While Casino Mode is on, relevant Pi events play short procedural sounds: activation, agent start, tool start, tool success/error, turn completion, agent settlement, and deactivation. The cues use a restrained volume and are rate-limited with a small pending queue cap, preserving anticipation and reward feedback without a dense stream of overlapping sounds. The sounds are synthesized as PCM/WAV data in memory and never written to disk.

The plugin uses the optional `speaker` backend when its native audio module is available. Otherwise it falls back to piping the in-memory sound to the platform's native player, with the terminal bell as a final fallback. Audio failures never break Pi.

Casino Mode changes UI and audio state only. It does not change the system prompt, tools, conversation, or model/provider cache.
