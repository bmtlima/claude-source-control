import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AttributionLog } from './attributionLog';
import { ConflictTracker } from './conflictTracker';
import { SessionSourceControl } from './sessionSourceControl';
import { gitStatusFiles, gitCheckoutFile, gitAddAndCommit } from './gitUtils';
import { NAME_POOL, SESSION_NAMES_FILE, SESSION_PIDS_FILE, DEBOUNCE_MS } from './constants';

/**
 * Orchestrates sessions:
 * - Listens to attribution log changes + git index changes
 * - Creates/updates per-session SCM panels
 * - Assigns friendly names to session IDs
 * - Debounced refresh
 * - Discard commands
 */
export class SessionManager implements vscode.Disposable {
    private _sessions = new Map<string, SessionSourceControl>();
    private _nameMap = new Map<string, string>(); // session_id → friendly name
    private _sessionTerminals = new Map<string, vscode.Terminal>();
    private _disposables: vscode.Disposable[] = [];
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _statusBar: vscode.StatusBarItem;
    private _gitIndexWatcher: fs.FSWatcher | null = null;
    private _terminalNameTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly repoRoot: string,
        private readonly attributionLog: AttributionLog,
        private readonly conflictTracker: ConflictTracker,
    ) {
        this._statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this._statusBar.command = 'multiClaude.refresh';
        this._disposables.push(this._statusBar);

        // Load persisted session names
        this._loadSessionNames();

        // Listen to attribution changes
        this._disposables.push(
            this.attributionLog.onDidChange(() => this._scheduleRefresh())
        );

        // Watch .git/index for commit/checkout detection
        this._watchGitIndex();

        // Watch workspace files for changes (catches discards from built-in Git SCM)
        const fsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.repoRoot, '**/*')
        );
        const claudeDir = path.join(this.repoRoot, '.claude');
        const gitDir = path.join(this.repoRoot, '.git');
        const onFileChange = (uri: vscode.Uri) => {
            // Ignore .claude/ and .git/ to avoid refresh loops
            // (_refresh writes .claude/ files, .git/index has its own watcher)
            if (uri.fsPath.startsWith(claudeDir) || uri.fsPath.startsWith(gitDir)) { return; }
            this._scheduleRefresh();
        };
        fsWatcher.onDidChange(onFileChange);
        fsWatcher.onDidCreate(onFileChange);
        fsWatcher.onDidDelete(onFileChange);
        this._disposables.push(fsWatcher);

        // Re-match terminal names on open/close and periodically (catches renames)
        this._disposables.push(
            vscode.window.onDidOpenTerminal(() => this._matchTerminals()),
            vscode.window.onDidCloseTerminal(() => this._matchTerminals()),
        );
        this._terminalNameTimer = setInterval(() => this._matchTerminals(), 5000);

        // Initial refresh
        this._scheduleRefresh();
    }

    private _loadSessionNames(): void {
        const namesPath = path.join(this.repoRoot, SESSION_NAMES_FILE);
        try {
            if (fs.existsSync(namesPath)) {
                const data = JSON.parse(fs.readFileSync(namesPath, 'utf-8'));
                if (data && typeof data === 'object') {
                    for (const [id, name] of Object.entries(data)) {
                        if (typeof name === 'string') {
                            this._nameMap.set(id, name);
                        }
                    }
                }
            }
        } catch {
            // Ignore corrupt file
        }
    }

    private _saveSessionNames(): void {
        const namesPath = path.join(this.repoRoot, SESSION_NAMES_FILE);
        const dir = path.dirname(namesPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const obj: Record<string, string> = {};
        for (const [id, name] of this._nameMap) {
            obj[id] = name;
        }
        fs.writeFileSync(namesPath, JSON.stringify(obj, null, 2) + '\n');
    }

    private _assignName(sessionId: string): string {
        let name = this._nameMap.get(sessionId);
        if (name) { return name; }

        // Find the first unused name from the pool
        const usedNames = new Set(this._nameMap.values());
        name = NAME_POOL.find(n => !usedNames.has(n));
        if (!name) {
            // All pool names taken — generate a numbered fallback
            let i = NAME_POOL.length + 1;
            do { name = `Session-${i++}`; } while (usedNames.has(name));
        }

        this._nameMap.set(sessionId, name);
        this._saveSessionNames();
        return name;
    }

    private _watchGitIndex(): void {
        const gitDir = path.join(this.repoRoot, '.git');
        try {
            this._gitIndexWatcher = fs.watch(gitDir, (_, filename) => {
                if (filename === 'index') {
                    this._scheduleRefresh();
                }
            });
        } catch {
            // .git may not exist yet or watch may fail
        }
    }

    private _scheduleRefresh(): void {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
        }
        this._refreshTimer = setTimeout(() => this._refresh(), DEBOUNCE_MS);
    }

    private async _refresh(): Promise<void> {
        try {
            // Get current git status
            const statusEntries = await gitStatusFiles(this.repoRoot);
            const uncommittedPaths = new Set(
                statusEntries.map(e => path.join(this.repoRoot, e.path))
            );
            const untrackedPaths = new Set(
                statusEntries
                    .filter(e => e.status === '??')
                    .map(e => path.join(this.repoRoot, e.path))
            );
            const deletedPaths = new Set(
                statusEntries
                    .filter(e => e.status[1] === 'D' || e.status[0] === 'D')
                    .map(e => path.join(this.repoRoot, e.path))
            );

            // Handle renames: transfer attribution from old path to new path
            for (const entry of statusEntries) {
                if (entry.origPath) {
                    const absOld = path.join(this.repoRoot, entry.origPath);
                    const absNew = path.join(this.repoRoot, entry.path);
                    this.attributionLog.transferAttribution(absOld, absNew);
                }
            }

            // Get attribution data
            const sessionFiles = this.attributionLog.sessionFiles;

            // For each session, intersect attributed files with uncommitted files
            const activeSessionFiles = new Map<string, Set<string>>();
            for (const [sessionId, files] of sessionFiles) {
                const relevantFiles = new Set<string>();
                for (const filePath of files) {
                    if (uncommittedPaths.has(filePath)) {
                        relevantFiles.add(filePath);
                    }
                }
                if (relevantFiles.size > 0) {
                    activeSessionFiles.set(sessionId, relevantFiles);
                }
            }

            // Update conflict tracker
            for (const [sessionId, files] of activeSessionFiles) {
                this.conflictTracker.update(sessionId, files);
            }
            // Clean up sessions that have no active files
            for (const sessionId of [...this._sessions.keys()]) {
                if (!activeSessionFiles.has(sessionId)) {
                    this.conflictTracker.update(sessionId, new Set());
                }
            }

            // Create/update SCM panels
            const activeSessions = new Set(activeSessionFiles.keys());

            // Remove panels for sessions with no active files
            for (const [sessionId, panel] of this._sessions) {
                if (!activeSessions.has(sessionId)) {
                    panel.cleanupPersistence();
                    panel.dispose();
                    this._sessions.delete(sessionId);
                    this._sessionTerminals.delete(sessionId);
                }
            }

            // Create or update panels for active sessions
            for (const [sessionId, files] of activeSessionFiles) {
                let panel = this._sessions.get(sessionId);
                if (!panel) {
                    const name = this._assignName(sessionId);
                    panel = new SessionSourceControl(sessionId, name, this.repoRoot);
                    this._sessions.set(sessionId, panel);
                }

                // Split into conflicts vs changes
                const conflicts = this.conflictTracker.getConflictsFor(sessionId);
                const conflictFiles: string[] = [];
                const changedFiles: string[] = [];
                for (const f of files) {
                    if (conflicts.has(f)) {
                        conflictFiles.push(f);
                    } else {
                        changedFiles.push(f);
                    }
                }
                panel.updateResources(changedFiles, conflictFiles, untrackedPaths, deletedPaths);
            }

            // Prune stale attribution entries and session names
            this.attributionLog.pruneEntries(uncommittedPaths);
            this._pruneSessionNames(activeSessions);

            // Match terminals to sessions
            await this._matchTerminals();

            // Update status bar
            this._updateStatusBar(activeSessions.size);
        } catch (err) {
            console.error('Multi-Claude refresh failed:', err);
        }
    }

    /** Match VS Code terminals to sessions using PID chain from hook. */
    private async _matchTerminals(): Promise<void> {
        const pidsPath = path.join(this.repoRoot, SESSION_PIDS_FILE);
        let pidChains: Record<string, number[]>;
        try {
            pidChains = JSON.parse(fs.readFileSync(pidsPath, 'utf-8'));
        } catch {
            return; // No PID data yet
        }

        // Build map of terminal PID → terminal
        const terminalPidMap = new Map<number, vscode.Terminal>();
        for (const t of vscode.window.terminals) {
            const pid = await t.processId;
            if (pid) { terminalPidMap.set(pid, t); }
        }

        for (const [sessionId, chain] of Object.entries(pidChains)) {
            if (!Array.isArray(chain)) { continue; }
            const panel = this._sessions.get(sessionId);
            if (!panel) { continue; }

            for (const pid of chain) {
                const terminal = terminalPidMap.get(pid);
                if (terminal) {
                    panel.setTerminalName(terminal.name);
                    this._sessionTerminals.set(sessionId, terminal);
                    break;
                }
            }
        }
    }

    /** Reveal the terminal associated with an SCM panel. */
    revealTerminal(sourceControl: vscode.SourceControl): void {
        for (const [sessionId, panel] of this._sessions) {
            if (panel.scm === sourceControl) {
                const terminal = this._sessionTerminals.get(sessionId);
                if (terminal) {
                    terminal.show();
                } else {
                    vscode.window.showInformationMessage('No matching terminal found for this session.');
                }
                return;
            }
        }
    }

    /** Remove session names and PID entries for sessions with no active files. */
    private _pruneSessionNames(activeSessions: Set<string>): void {
        let changed = false;
        for (const sessionId of [...this._nameMap.keys()]) {
            if (!activeSessions.has(sessionId)) {
                this._nameMap.delete(sessionId);
                changed = true;
            }
        }
        if (changed) {
            this._saveSessionNames();
            this._pruneSessionPids(activeSessions);
        }
    }

    /** Remove PID entries for dead sessions. */
    private _pruneSessionPids(activeSessions: Set<string>): void {
        const pidsPath = path.join(this.repoRoot, SESSION_PIDS_FILE);
        try {
            const data: Record<string, unknown> = JSON.parse(fs.readFileSync(pidsPath, 'utf-8'));
            let pruned = false;
            for (const sessionId of Object.keys(data)) {
                if (!activeSessions.has(sessionId)) {
                    delete data[sessionId];
                    pruned = true;
                }
            }
            if (pruned) {
                if (Object.keys(data).length === 0) {
                    fs.unlinkSync(pidsPath);
                } else {
                    fs.writeFileSync(pidsPath, JSON.stringify(data));
                }
            }
        } catch {
            // File may not exist yet
        }
    }

    private _updateStatusBar(sessionCount: number): void {
        if (sessionCount === 0) {
            this._statusBar.hide();
            return;
        }
        const conflicts = this.conflictTracker.conflictCount;
        let text = `$(git-branch) ${sessionCount} session${sessionCount !== 1 ? 's' : ''}`;
        if (conflicts > 0) {
            text += ` $(warning) ${conflicts} conflict${conflicts !== 1 ? 's' : ''}`;
        }
        this._statusBar.text = text;
        this._statusBar.show();
    }

    /** Discard a single file — revert to HEAD (tracked) or delete (untracked). */
    async discardFile(uri: vscode.Uri): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Discard changes to ${path.basename(uri.fsPath)}?`,
            { modal: true },
            'Discard',
        );
        if (confirm !== 'Discard') { return; }

        const relativePath = path.relative(this.repoRoot, uri.fsPath);
        try {
            await gitCheckoutFile(this.repoRoot, relativePath);
        } catch {
            // Untracked file — delete it
            try {
                fs.unlinkSync(uri.fsPath);
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to delete ${relativePath}: ${e}`);
                return;
            }
        }
        this._scheduleRefresh();
    }

    /** Discard all files for a session. */
    async discardAll(sourceControl: vscode.SourceControl): Promise<void> {
        // Find the session for this SCM
        let targetSession: SessionSourceControl | undefined;
        for (const panel of this._sessions.values()) {
            if (panel.scm === sourceControl) {
                targetSession = panel;
                break;
            }
        }
        if (!targetSession) { return; }

        const allResources = [
            ...targetSession.changesGroup.resourceStates,
            ...targetSession.conflictsGroup.resourceStates,
        ];
        if (allResources.length === 0) { return; }

        const confirm = await vscode.window.showWarningMessage(
            `Discard all ${allResources.length} change(s) from "${targetSession.sessionName}"?`,
            { modal: true },
            'Discard All',
        );
        if (confirm !== 'Discard All') { return; }

        for (const resource of allResources) {
            const relativePath = path.relative(this.repoRoot, resource.resourceUri.fsPath);
            try {
                await gitCheckoutFile(this.repoRoot, relativePath);
            } catch {
                try {
                    fs.unlinkSync(resource.resourceUri.fsPath);
                } catch {
                    // Skip failures on individual files
                }
            }
        }
        this._scheduleRefresh();
    }

    /** Dismiss a session panel manually. */
    dismissSession(sourceControl: vscode.SourceControl): void {
        for (const [sessionId, panel] of this._sessions) {
            if (panel.scm === sourceControl) {
                panel.cleanupPersistence();
                panel.dispose();
                this._sessions.delete(sessionId);
                this._sessionTerminals.delete(sessionId);
                this.conflictTracker.removeSession(sessionId);
                this.attributionLog.removeSession(sessionId);
                this._pruneSessionNames(new Set(this._sessions.keys()));
                break;
            }
        }
    }

    /** Force a manual refresh. */
    refresh(): void {
        this._scheduleRefresh();
    }

    /** Stage a file in its session panel. */
    stageFile(resourceState: vscode.SourceControlResourceState): void {
        const panel = this._findPanelForUri(resourceState.resourceUri);
        if (!panel) { return; }
        panel.stageFile(resourceState.resourceUri.fsPath);
        // Refresh immediately (no debounce) so UI feels instant
        this._refresh();
    }

    /** Unstage a file in its session panel. */
    unstageFile(resourceState: vscode.SourceControlResourceState): void {
        const panel = this._findPanelForUri(resourceState.resourceUri);
        if (!panel) { return; }
        panel.unstageFile(resourceState.resourceUri.fsPath);
        this._refresh();
    }

    /** Stage all files in a session panel. */
    stageAll(group: vscode.SourceControlResourceGroup): void {
        const panel = this._findPanelForGroup(group);
        if (!panel) { return; }
        panel.stageAll();
        this._refresh();
    }

    /** Unstage all files in a session panel. */
    unstageAll(group: vscode.SourceControlResourceGroup): void {
        const panel = this._findPanelForGroup(group);
        if (!panel) { return; }
        panel.unstageAll();
        this._refresh();
    }

    /** Commit from the title bar button (receives SourceControl). */
    async commitFromScm(sourceControl: vscode.SourceControl): Promise<void> {
        const panel = this._findPanelForScm(sourceControl);
        if (!panel) { return; }
        await this.commitSession(panel);
    }

    /** Commit only the staged files from a session. */
    async commitSession(panel: SessionSourceControl): Promise<void> {
        const message = panel.scm.inputBox.value.trim();
        if (!message) {
            vscode.window.showWarningMessage('Please enter a commit message.');
            return;
        }

        const filePaths = panel.getStagedResourcePaths();
        if (filePaths.length === 0) {
            vscode.window.showWarningMessage('No staged files to commit. Stage files first with the + button.');
            return;
        }

        const relativePaths = filePaths.map(f => path.relative(this.repoRoot, f));
        try {
            await gitAddAndCommit(this.repoRoot, relativePaths, message);
            panel.scm.inputBox.value = '';
            panel.clearStagedPaths(filePaths);
            vscode.window.showInformationMessage(
                `Committed ${relativePaths.length} file(s) from "${panel.sessionName}".`
            );
            // Refresh built-in Git SCM so "Sync Changes" appears
            vscode.commands.executeCommand('git.refresh');
            this._scheduleRefresh();
        } catch (err) {
            vscode.window.showErrorMessage(`Commit failed: ${err}`);
        }
    }

    private _findPanelForUri(uri: vscode.Uri): SessionSourceControl | undefined {
        for (const panel of this._sessions.values()) {
            if (panel.stagedPaths.has(uri.fsPath)) { return panel; }
            for (const r of panel.stagedGroup.resourceStates) {
                if (r.resourceUri.fsPath === uri.fsPath) { return panel; }
            }
            for (const r of panel.changesGroup.resourceStates) {
                if (r.resourceUri.fsPath === uri.fsPath) { return panel; }
            }
            for (const r of panel.conflictsGroup.resourceStates) {
                if (r.resourceUri.fsPath === uri.fsPath) { return panel; }
            }
        }
        return undefined;
    }

    private _findPanelForScm(scm: vscode.SourceControl): SessionSourceControl | undefined {
        for (const panel of this._sessions.values()) {
            if (panel.scm === scm) { return panel; }
        }
        return undefined;
    }

    private _findPanelForGroup(group: vscode.SourceControlResourceGroup): SessionSourceControl | undefined {
        for (const panel of this._sessions.values()) {
            if (panel.stagedGroup === group || panel.changesGroup === group || panel.conflictsGroup === group) {
                return panel;
            }
        }
        return undefined;
    }

    /** Get session name for display purposes. */
    getSessionName(sessionId: string): string | undefined {
        return this._nameMap.get(sessionId);
    }

    dispose(): void {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
        }
        if (this._terminalNameTimer) {
            clearInterval(this._terminalNameTimer);
        }
        this._gitIndexWatcher?.close();
        for (const panel of this._sessions.values()) {
            panel.cleanupPersistence();
            panel.dispose();
        }
        this._sessions.clear();
        for (const d of this._disposables) { d.dispose(); }
    }
}
