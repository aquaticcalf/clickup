# Prompt loader

The prompt loader reads every `*.txt` file under the repository's `prompts/` directory, including nested directories, and appends their contents as a system-level prompt before each agent run.

Files are loaded in deterministic alphabetical order. The extension is active while this plugin is loaded; disable it by removing or filtering `plugins/prompts/index.ts` from pi's package configuration.

## Command

```text
/prompts
```

`/prompts` toggles local-prompts-only mode. The preference persists in `~/.pi/agent/prompts.json` and is restored for future sessions. In that mode, pi's prompt instructions are removed and the repository prompts are sent as a separate `system` message. Every registered tool is enabled, including built-in and other extension tools. Running `/prompts` again restores pi's prompt instructions and the tool selection that was active before the toggle. Local prompts are sent as a system message in both modes.
