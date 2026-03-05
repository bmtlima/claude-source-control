# Multi-Claude

VS Code extension that gives each Claude Code session its own Source Control panel. When you run multiple Claude agents simultaneously, each one gets a named panel (Rainbow, Falcon, Aurora...) showing only the files *that agent* modified. It also detects conflicts when multiple sessions touch the same file.

## How it works

1. A **PostToolUse hook** intercepts Claude's `Edit`/`Write` tool calls and logs `{session_id, file_path}` to `.claude/file-attribution.jsonl`
2. The extension watches that file and intersects attribution data with `git status` — only files that are both attributed to a session AND uncommitted appear in the UI
3. Each session gets its own SCM panel with **Staged Changes**, **Changes**, and **Conflicts** groups
4. Files touched by 2+ sessions are flagged as conflicts

## Setup

```bash
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

The extension auto-installs its attribution hook into `.claude/settings.local.json` on activation. You can also run **Multi-Claude: Install Attribution Hook** from the command palette.

## Usage

Once installed, just use Claude Code normally. Each Claude session that edits files will automatically appear as a named panel in the Source Control sidebar. From there you can:

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

## Architecture

```
src/
├── extension.ts              Entry point, registers commands
├── sessionManager.ts         Orchestrates sessions, refresh loop, commit/discard
├── sessionSourceControl.ts   Per-session SCM panel (Staged/Changes/Conflicts)
├── attributionLog.ts         Watches .claude/file-attribution.jsonl
├── conflictTracker.ts        Flags files touched by 2+ sessions
├── gitUtils.ts               Git CLI wrapper (status, checkout, commit)
├── gitHeadContentProvider.ts Content provider for diff views against HEAD
├── hookInstaller.ts          Installs the PostToolUse attribution hook
└── constants.ts              Paths, name pool, config
```

### Runtime files (in `.claude/`, gitignored)

| File | Purpose |
|------|---------|
| `file-attribution.jsonl` | Append-only log from the hook, pruned on refresh |
| `session-names.json` | Maps session UUIDs to friendly names |
| `staged-files.json` | Persists staged file state across VS Code restarts |
| `hooks/log-attribution.sh` | The hook script itself |
| `settings.local.json` | Hook configuration (should be committed) |

## Testing without Claude

You can simulate sessions by manually appending to the attribution log:

```bash
mkdir -p .claude

# Simulate session A editing a file
echo '{"session_id":"aaa","file_path":"src/extension.ts","tool_name":"Edit","timestamp":1709500000}' >> .claude/file-attribution.jsonl

# Simulate session B editing the same file (creates a conflict)
echo '{"session_id":"bbb","file_path":"src/extension.ts","tool_name":"Edit","timestamp":1709500001}' >> .claude/file-attribution.jsonl
```

The attributed files must also show up in `git status` (i.e., have uncommitted changes) to appear in the panels.

## Known limitations

- Single-workspace only (uses `workspaceFolders[0]`)
- No push/pull/sync — use the built-in Git panel for that
- Hook requires `node` on PATH
- No handling for detached HEAD or rebase state
