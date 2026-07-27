# HIG

An always-loaded visual baseline for pi inspired by Apple's Human Interface Guidelines: calm contrast, clear hierarchy, restrained color, and readable defaults.

HIG applies its theme at session startup without changing the saved user theme setting. It opens the interactive TUI in the terminal's alternate screen, keeps the editor/footer anchored to the bottom of the viewport, and lets mouse-wheel/PageUp/PageDown scroll only the conversation above it. Up/Down remain prompt-history keys. It shows a large, centered animated smile only while the conversation is empty. Other visual plugins can temporarily override its colors while HIG's no-clutter baseline remains active; for example, `/casino` adds its fun skin while active and restores HIG when turned off.

HIG intentionally adds no commands, sounds, or conversation content. Pi's working indicator remains visible while the agent runs. The empty-state smile disappears as soon as you type or a conversation message exists.
