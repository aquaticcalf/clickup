# rtk

integrates [rtk](https://github.com/rtk-ai/rtk) with pi. bash commands are passed through `rtk rewrite` before execution, so supported commands produce compact output for the model.

## requirements

install the `rtk` binary separately and make sure it is on `PATH`:

```text
rtk >= 0.23.0
```

if rtk is unavailable, this plugin remains loaded but passes bash commands through unchanged.

## command

```text
/rtk          toggle rewriting and show status
```

The enabled state persists in `~/.pi/agent/rtk.json`, like Casino Mode. RTK is enabled by default when no preference has been saved.

set `RTK_DISABLED=1` for a single command to bypass rewriting. commands already beginning with `rtk` are left unchanged.

this plugin only handles pi's `bash` tool. it does not alter read, edit, write, grep, find, or other tool calls. all rewrite failures fail open and execute the original command.
