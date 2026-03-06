import * as fs from 'fs';
import * as path from 'path';
import { HOOK_SCRIPT, HOOK_SCRIPT_PATH, SETTINGS_LOCAL_PATH, CLAUDE_DIR } from './constants';

/**
 * Installs the PostToolUse hook that logs file attribution.
 * - Writes .claude/hooks/log-attribution.sh
 * - Merges hook config into .claude/settings.local.json
 */
export async function installHook(workspaceRoot: string): Promise<void> {
    const claudeDir = path.join(workspaceRoot, CLAUDE_DIR);
    const hooksDir = path.join(workspaceRoot, CLAUDE_DIR, 'hooks');
    const scriptPath = path.join(workspaceRoot, HOOK_SCRIPT_PATH);
    const settingsPath = path.join(workspaceRoot, SETTINGS_LOCAL_PATH);

    // Ensure directories exist
    fs.mkdirSync(hooksDir, { recursive: true });

    // Write hook script
    fs.writeFileSync(scriptPath, HOOK_SCRIPT, { mode: 0o755 });

    // Read or create settings.local.json
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        } catch {
            // Corrupted file — overwrite
            settings = {};
        }
    }

    // Merge hook config
    const hookEntry = {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [
            {
                type: 'command',
                command: path.join(workspaceRoot, HOOK_SCRIPT_PATH),
            },
        ],
    };

    const hooks = (settings['hooks'] as Record<string, unknown[]>) ?? {};
    const postToolUse = (hooks['PostToolUse'] as unknown[]) ?? [];

    // Check if our hook is already installed
    const alreadyInstalled = postToolUse.some((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null) { return false; }
        const e = entry as Record<string, unknown>;
        if (e['matcher'] !== 'Edit|Write|MultiEdit|NotebookEdit') { return false; }
        const entryHooks = e['hooks'] as Array<Record<string, unknown>> | undefined;
        return entryHooks?.some(h => {
            const cmd = h['command'] as string | undefined;
            return cmd?.includes('log-attribution.sh');
        });
    });

    if (!alreadyInstalled) {
        postToolUse.push(hookEntry);
        hooks['PostToolUse'] = postToolUse;
        settings['hooks'] = hooks;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
}

/** Returns true if the hook is already installed. */
export function isHookInstalled(workspaceRoot: string): boolean {
    const scriptPath = path.join(workspaceRoot, HOOK_SCRIPT_PATH);
    return fs.existsSync(scriptPath);
}

/**
 * Ensures the extension's runtime files under .claude/ are listed in .gitignore.
 * Appends missing entries; does not duplicate existing ones.
 */
export function ensureGitignore(workspaceRoot: string): void {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');

    const entriesToIgnore = [
        '.claude/file-attribution.jsonl',
        '.claude/session-names.json',
        '.claude/staged-files.json',
        '.claude/session-pids.json',
        '.claude/hooks/',
    ];

    let existing = '';
    if (fs.existsSync(gitignorePath)) {
        existing = fs.readFileSync(gitignorePath, 'utf-8');
    }

    const lines = existing.split('\n').map(l => l.trim());
    const missing = entriesToIgnore.filter(entry => !lines.includes(entry));

    if (missing.length === 0) { return; }

    const block = '\n# Claude Source Control (auto-generated)\n' + missing.join('\n') + '\n';
    fs.appendFileSync(gitignorePath, block);
}
