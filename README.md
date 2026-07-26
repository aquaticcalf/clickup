# @aquaticcalf/pi-plugins

A pnpm workspace and distributable pi package containing independently loadable plugins.

## Plugins

| Plugin | Location | Purpose |
|---|---|---|
| ClickUp | `plugins/clickup/` | Command-gated ClickUp API access with CRUD permissions |

More integrations can be added under `plugins/<name>/` without changing the collection architecture.

## Try without cloning or permanently installing

Run the published GitHub package for one pi session:

```bash
pi -e git:github.com/aquaticcalf/clickup@master
```

This uses pi's temporary extension loading. It does not add the package to your pi settings. See each plugin's README for its commands.

## Selective plugin loading

The root package discovers plugin entrypoints with `./plugins/*/index.ts`. To load only selected plugins from a package installation, use a filtered package entry in pi settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/aquaticcalf/clickup@master",
      "extensions": ["plugins/clickup/index.ts"]
    }
  ]
}
```

You can also use `pi config` to enable or disable individual extensions.

## Permanent installation

```bash
pi install git:github.com/aquaticcalf/clickup@master
```

From a local checkout:

```bash
pnpm install
pi install .
```

## pnpm workspace development

This repository uses pnpm workspaces and a shared catalog for all dependency versions, including Pi SDK packages:

```bash
pnpm install
pnpm typecheck
```

Pi uses npm by default when installing Git packages. To make Pi use pnpm, add this to `~/.pi/agent/settings.json`:

```json
{
  "npmCommand": ["pnpm"]
}
```

The `packageManager` field pins the workspace to pnpm 11.17.0. A new terminal may be needed after installing pnpm so it is on `PATH`.

## Adding a plugin

Create a new workspace package:

```text
plugins/my-plugin/
├── package.json
├── README.md
└── index.ts
```

Add its entrypoint under `plugins/my-plugin/index.ts`. The root Pi manifest discovers it automatically, while package filters let users choose which plugins load.
