# Multi-Claude: VS Code Extension for Multi-Agent Coordination

## What this does

Shows per-agent Source Control panels in VS Code's sidebar. Each agent gets its own "box" showing which files it changed, with click-to-diff, accept/discard buttons, and conflict detection when multiple agents touch the same file.

## Architecture

```
Your project/
├── src/                      ← your real code
├── .claude-agents/
│   ├── auth-middleware/      ← full copy of project, agent 1 works here
│   │   └── src/...           
│   └── settings-page/        ← full copy of project, agent 2 works here
│       └── src/...
```

Each agent gets a copy of your project in `.claude-agents/<name>/`. Claude Code (or you, for testing) edits files there. The extension diffs each agent's copy against your real working directory and shows the results in the Source Control sidebar.

**No git branches. No worktrees. No merges.** Agents never touch your real files. You accept changes by clicking a button, which copies the file from the agent's directory into your workspace.

## How to develop and test

### Setup
```bash
cd multi-claude-extension
npm install
```

### Dev workflow
1. Open this folder in VS Code
2. Press F5 — this launches a second VS Code window (Extension Development Host)
3. In the dev host window, open any project folder
4. Create a `.claude-agents/` directory in that project
5. Create a subdirectory per agent (e.g., `.claude-agents/test-agent/`)
6. Copy some files from the project into the agent dir and modify them
7. Open the Source Control sidebar — you should see a panel for each agent

### Quick test script
In the test project, run:
```bash
# Create agent directories
mkdir -p .claude-agents/agent-1-auth
mkdir -p .claude-agents/agent-2-ui

# Copy a file and modify it to simulate agent work
cp src/index.ts .claude-agents/agent-1-auth/src/index.ts
echo "// Modified by agent 1" >> .claude-agents/agent-1-auth/src/index.ts

cp src/index.ts .claude-agents/agent-2-ui/src/index.ts
echo "// Modified by agent 2" >> .claude-agents/agent-2-ui/src/index.ts

# agent-2 also creates a new file
mkdir -p .claude-agents/agent-2-ui/src/components
echo "export const Button = () => <button>Click</button>" > .claude-agents/agent-2-ui/src/components/Button.tsx
```

You should see:
- Two SCM panels: "Agent 1 Auth" and "Agent 2 Ui"
- `src/index.ts` shows as a conflict (both agents modified it)
- `src/components/Button.tsx` shows as a new file in Agent 2's panel
- Clicking any file opens a diff view
- Status bar shows "2 agent(s), 1 conflict(s)"

### Reloading after code changes
Ctrl+R (Cmd+R on Mac) in the dev host window to reload the extension.

## Commands

- `Multi-Claude: Create Agent` — creates a new agent with a copy of the workspace
- `Multi-Claude: Remove Agent` — deletes an agent and its working copy
- Accept/Discard buttons appear on each file and each panel header in the SCM sidebar

## What's NOT in this MVP

- No Claude Code integration (agents are just directories you put files in)
- No manifest/advisory locking  
- No hunk-level accept (only whole-file)
- No three-way merge for conflicts
- No symlinked node_modules (copies exclude node_modules entirely)

## Next steps after validating the UI

1. Add Claude Code headless integration (spawn agents from command palette)
2. Add manifest.json for advisory locking between agents
3. Symlink node_modules into agent dirs so code can actually run
4. Hunk-level accept using VS Code's diff editor
5. Three-way diff for conflicting files
