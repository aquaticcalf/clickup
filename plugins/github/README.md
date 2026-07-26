# GitHub pi plugin

A settings-style GitHub workflow for pi, powered by the GitHub CLI (`gh`).

## Requirements

- Git
- [GitHub CLI](https://cli.github.com/)
- `gh auth login` completed for the repository

## Menu

Run `/github` to open the nested menu. It provides:

- Safe PR checkout and return
- Safe current-directory PR checkout and return
- PR details, diffs, browser links, and issue browsing
- CI/check status and check waiting
- Confirmation-gated PR creation, pushing, comments, editing, state changes, ready-for-review, and merging
- Persisted local safety settings
- Read-only `#123` issue autocomplete

The menu follows pi's `/settings` style: `SettingsList` rows open nested submenus, `SelectList` chooses PRs/issues, and Escape goes back.

## Safety

PR checkout requires a clean tree by default. The optional assisted-commit policy stages and commits all changes only after confirmation; it never pushes automatically. The plugin does not reset, clean, force-checkout, or silently push.

PR checkout happens directly in the current repository as a detached checkout.
