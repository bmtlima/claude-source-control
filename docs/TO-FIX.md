# TO-FIX

## 1. No commit functionality on agent panels
- `scm.inputBox.visible = false` (line 26) hides the commit message input
- No `acceptInputCommand` set on the SCM provider
- Without both, there's no way to commit from agent panels
- The current accept/discard model isn't surfaced well to the user

## 2. No `rootUri` on SCM providers (lines 22-25)
- `createSourceControl` accepts an optional 3rd argument `rootUri`
- Without it, VS Code doesn't know what directory each agent provider manages
- Affects how files are displayed and grouped in the SCM view

## 3. Broken diff for new files (line 75)
- `vscode.Uri.parse('untitled:empty')` doesn't produce a proper empty document for the left side of a diff
- Will either show an error or open an untitled editor tab instead of an empty comparison

## 4. Deleted files are never detected (lines 107-161)
- `findChangedFiles` only scans files that exist in the agent directory
- If an agent deletes a file from its working copy, that deletion is invisible

## 5. No debouncing on file watcher (lines 41-50)
- Every single file change triggers a full recursive directory scan + content comparison
- Rapid changes cause a storm of `refresh()` calls

## 6. Accept doesn't trigger cross-agent refresh (lines 166-178)
- Accepting a file from agent-1 changes the workspace file
- Agent-2 only watches its own directory, so it doesn't detect the workspace change
- Conflict status for other agents becomes stale

## ~~7. `stageAll`/`unstageAll` receive wrong argument type~~ (fixed)
- `scm/resourceGroup/context` items pass `SourceControlResourceGroup`, not `SourceControl`
- Fixed by adding `_findPanelForGroup()` and updating `stageAll`/`unstageAll` signatures

## 8. Agent-1 only shows "Conflicts", missing "Changes" tab
- When both agents modify the same file (e.g. `src/index.ts`), Agent-1 shows it under Conflicts only
- But Agent-2 shows both a Changes group (for `src/components/Button.tsx`) and a Conflicts group (for `src/index.ts`)
- Agent-1 has no non-conflicting files, so its Changes group is empty and hidden (`hideWhenEmpty = true`)
- This is technically correct behavior but creates a confusing asymmetric UX where Agent-1 appears to have no "normal" changes at all
