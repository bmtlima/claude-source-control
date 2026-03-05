import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AttributionLog } from './attributionLog';
import { ConflictTracker } from './conflictTracker';
import { SessionSourceControl } from './sessionSourceControl';
import { gitStatusFiles, gitCheckoutFile, gitAddAndCommit } from './gitUtils';
import { NAME_POOL, SESSION_NAMES_FILE, DEBOUNCE_MS } from './constants';

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
    private _disposables: vscode.Disposable[] = [];
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _statusBar: vscode.StatusBarItem;
    private _gitIndexWatcher: fs.FSWatcher | null = null;

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
        const gitIndexPath = path.join(this.repoRoot, '.git', 'index');
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
                    panel.dispose();
                    this._sessions.delete(sessionId);
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

            // Update status bar
            this._updateStatusBar(activeSessions.size);
        } catch (err) {
            console.error('Multi-Claude refresh failed:', err);
        }
    }

    /** Remove session names for sessions with no active files. */
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
            `Revert ${path.basename(uri.fsPath)} to HEAD?`,
            { modal: true },
            'Revert',
        );
        if (confirm !== 'Revert') { return; }

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
            `Revert all ${allResources.length} file(s) from "${targetSession.sessionName}" to HEAD?`,
            { modal: true },
            'Revert All',
        );
        if (confirm !== 'Revert All') { return; }

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
        this._gitIndexWatcher?.close();
        for (const panel of this._sessions.values()) {
            panel.dispose();
        }
        this._sessions.clear();
        for (const d of this._disposables) { d.dispose(); }
    }
}
