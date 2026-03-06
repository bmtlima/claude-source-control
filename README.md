<h1 align="center">Claude Source Control</h1>

<p align="center">
  Per-session source control panels for multiple Claude Code agents.
</p>

---

Running multiple Claude Code sessions at once? This extension gives each one its own Source Control panel — named Eclipse, Quasar, Nebula, etc. — showing only the files **that agent** modified. It also flags conflicts when two sessions touch the same file.

## Quick Start

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=bmtlima.multi-claude)
2. Open any git repo in VS Code
3. Use Claude Code normally — each session that edits files gets its own panel in the Source Control sidebar

The extension auto-installs a lightweight hook the first time it activates. No configuration needed.

## What You Get

- **Per-session SCM panels** — each Claude session gets its own panel, so you always know which agent changed what
- **Conflict detection** — files modified by 2+ sessions are flagged with a warning
- **Stage, commit, discard** — manage changes per-session, independently of the built-in Git panel
- **Diff against HEAD** — click any file to see what changed
- **Terminal linking** — each panel links to its Claude Code terminal (click to reveal)
- **File decorations** — modified/added/deleted/conflicted files are badged in the explorer
- **Status bar** — shows active session names and conflict count at a glance

## Usage

From the Source Control sidebar:

- **Click a file** to diff it against HEAD
- **Stage/unstage files** with the +/- buttons
- **Commit** staged files per-session with a commit message
- **Discard** changes to revert individual files or entire sessions to HEAD
- **Dismiss** a session panel when you're done with it

## How It Works

1. On activation, the extension installs a **PostToolUse hook** into `.claude/settings.local.json`. This hook runs after every `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool call and logs `{session_id, file_path}` to `.claude/file-attribution.jsonl`.
2. The extension watches that file and intersects attribution data with `git status` — only files that are both **attributed to a session AND uncommitted** appear in the panel.
3. Each session gets its own SCM panel with **Staged Changes**, **Changes**, and **Conflicts** groups.
4. Files touched by 2+ sessions are flagged as conflicts.
5. When you commit or discard, stale entries are automatically cleaned up.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `multiClaude.autoShowRepositories` | `false` | Automatically show the Source Control Repositories view when Claude sessions are detected. When disabled (default), session panels are still created but you must manually enable the Repositories view from the Source Control menu (⋯) to see and toggle them. |

To change a setting, open **Settings** (`Cmd+,` / `Ctrl+,`), search for "multiClaude", and toggle the option. Or add it directly to your `settings.json`:

```json
"multiClaude.autoShowRepositories": true
```

> **Tip:** The Source Control sidebar has a three-dot menu (⋯) at the top where you can toggle **Repositories**, **Changes**, and **Graph**. The Repositories view lets you check/uncheck which session panels are visible — useful when you're running many agents and only want to focus on a few.

## Commands

| Command | Description |
|---------|-------------|
| `Multi-Claude: Install Attribution Hook` | Re-install the hook if it was removed or corrupted |
| `Multi-Claude: Refresh Panels` | Force-refresh all session panels |

Stage, unstage, commit, discard, and dismiss are available via inline buttons on the SCM panels.

## Requirements

- VS Code 1.85+
- `node` on PATH (the hook script uses it)
- A git repository

## Known Limitations

- Single-workspace only (uses the first workspace folder)
- No push/pull/sync — use the built-in Git panel for remote operations

## Links

- [GitHub Repository](https://github.com/bmtlima/claude-source-control)
- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=bmtlima.multi-claude)

## License

MIT
