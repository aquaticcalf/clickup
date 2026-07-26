# Prompt loader

The prompt loader reads every `*.txt` file under the repository's `prompts/` directory, including nested directories, and appends their contents to pi's system prompt before each agent run.

Files are loaded in deterministic alphabetical order. The extension is active while this plugin is loaded; disable it by removing or filtering `plugins/prompts/index.ts` from pi's package configuration.
