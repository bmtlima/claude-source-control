# CLAUDE.md

## Project

VS Code SCM extension: per-session Source Control panels for multiple Claude Code agents.

## Build & test

```bash
npm run compile    # TypeScript → out/
npm run watch      # Compile on save
```

Press F5 in VS Code to launch the Extension Development Host. Ctrl+R / Cmd+R to reload after changes.

No test suite yet. Test manually by simulating attribution entries (see README).

## Architecture

- `src/extension.ts` — Entry point, command registration
- `src/sessionManager.ts` — Orchestrator: refresh loop, name assignment, commit/discard/stage
- `src/sessionSourceControl.ts` — Per-session SCM panel with Staged/Changes/Conflicts groups
- `src/attributionLog.ts` — Watches `.claude/file-attribution.jsonl`, maintains session-to-files map
- `src/conflictTracker.ts` — Flags files modified by 2+ sessions
- `src/gitUtils.ts` — Thin wrapper around git CLI (status, checkout, add+commit)
- `src/gitHeadContentProvider.ts` — Provides file content at HEAD for diff views
- `src/hookInstaller.ts` — Installs the PostToolUse hook into `.claude/settings.local.json`
- `src/constants.ts` — Paths, name pool, hook script

## Data flow

1. PostToolUse hook appends `{session_id, file_path, tool_name, timestamp}` to `.claude/file-attribution.jsonl`
2. `AttributionLog` watches that file via fs.watch, reads incrementally by byte offset
3. `SessionManager._refresh()` intersects attribution with `git status --porcelain` — only files that are both attributed AND uncommitted appear
4. Each session gets a `SessionSourceControl` panel; conflicts detected by `ConflictTracker`
5. On refresh, stale JSONL entries (committed files) are pruned; dead session names are removed

## Key conventions

- All file paths in `_stagedPaths` and `attributionLog.sessionFiles` are **absolute paths**
- Git status paths are **relative to repo root** — joined with `this.repoRoot` before comparison
- Session names are assigned from `NAME_POOL` by finding the first unused name (not by index)
- Staged files persist to `.claude/staged-files.json`; keyed by session ID
- The JSONL is pruned every refresh cycle, not just on commit

## Runtime files

These live in `.claude/` and should be gitignored (except `settings.local.json`):
- `file-attribution.jsonl` — attribution log
- `session-names.json` — session ID to name mapping
- `staged-files.json` — persisted staging state
- `hooks/log-attribution.sh` — the hook script

## Gotchas

- `createSourceControl` must NOT receive a `rootUri` parameter — it causes VS Code to prefix the workspace folder name to the panel label
- The `scm/title` menu passes `SourceControl` to command handlers, not `SourceControlResourceGroup`
- The `scm/resourceGroup/context` menu passes `SourceControlResourceGroup` to command handlers
- The hook script uses inline Node.js via bash — requires `node` on PATH
- Pruning happens on every refresh; don't assume JSONL entries persist after files are committed
