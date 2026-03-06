<h1 align="center">Claude Source Control</h1>

<p align="center">
  Per-session source control panels for multiple Claude Code agents.
</p>

---

Running multiple Claude Code sessions at once? This extension gives each one its own Source Control panel — named Rainbow, Falcon, Aurora, etc. — showing only the files **that agent** modified. It also flags conflicts when two sessions touch the same file.

## Features

- **Per-session SCM panels** — each Claude session gets its own panel in the Source Control sidebar
- **Automatic file attribution** — a PostToolUse hook tracks which session edited which files
- **Conflict detection** — files modified by 2+ sessions are flagged
- **Stage, commit, discard** — manage changes per-session, independently of the built-in Git panel
- **Diff against HEAD** — click any file to see what changed
- **Session names** — friendly names auto-assigned from a pool (Rainbow, Falcon, Aurora...)

## Getting Started

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=bmtlima.multi-claude)
2. Open a project that uses Claude Code (has a `.claude/` directory)
3. The extension automatically installs its attribution hook on activation
4. Use Claude Code normally — each session that edits files will appear as a named panel in the Source Control sidebar

You can also manually install the hook via the command palette: **Claude Source Control: Install Attribution Hook**

## Usage

Once installed, just use Claude Code normally. From the Source Control sidebar you can:

- **Click a file** to diff it against HEAD
- **Stage/unstage files** with the +/- buttons
- **Commit** staged files per-session with a commit message
- **Discard** changes to revert individual files or entire sessions to HEAD
- **See conflicts** when multiple sessions modify the same file

## Commands

| Command | Description |
|---------|-------------|
| `Multi-Claude: Install Attribution Hook` | (Re)install the PostToolUse hook |
| `Multi-Claude: Refresh Panels` | Force-refresh all session panels |
| Stage / Unstage / Commit / Discard | Available via inline buttons on SCM panels |

## How It Works

1. A **PostToolUse hook** intercepts Claude's `Edit`/`Write` tool calls and logs `{session_id, file_path}` to `.claude/file-attribution.jsonl`
2. The extension watches that file and intersects attribution data with `git status` — only files that are both attributed AND uncommitted appear
3. Each session gets its own SCM panel with **Staged Changes**, **Changes**, and **Conflicts** groups
4. Files touched by 2+ sessions are flagged as conflicts
5. Stale entries are pruned every refresh cycle

## Known Limitations

- Single-workspace only (uses `workspaceFolders[0]`)
- No push/pull/sync — use the built-in Git panel for that
- Hook requires `node` on PATH

## License

MIT
