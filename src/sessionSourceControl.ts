import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitHeadContentProvider } from './gitHeadContentProvider';
import { STAGED_FILES_PATH } from './constants';

/**
 * Manages a single SCM panel for one Claude Code session.
 * Shows real workspace files attributed to this session.
 */
export class SessionSourceControl implements vscode.Disposable {
    readonly scm: vscode.SourceControl;
    readonly stagedGroup: vscode.SourceControlResourceGroup;
    readonly changesGroup: vscode.SourceControlResourceGroup;
    readonly conflictsGroup: vscode.SourceControlResourceGroup;
    private _stagedPaths = new Set<string>(); // absolute paths the user has staged
    private _disposables: vscode.Disposable[] = [];

    constructor(
        readonly sessionId: string,
        readonly sessionName: string,
        readonly repoRoot: string,
    ) {
        this.scm = vscode.scm.createSourceControl(
            `multiClaude.${sessionId}`,
            `${sessionName}`,
        );

        // Load persisted staged paths
        this._loadStagedPaths();

        // Enable commit input box with Commit button
        this.scm.inputBox.placeholder = `Commit message for "${sessionName}"`;
        this.scm.acceptInputCommand = {
            command: 'multiClaude.commitSession',
            title: 'Commit',
            arguments: [this],
        };
        this.scm.commitTemplate = '';

        // QuickDiffProvider for gutter decorations
        this.scm.quickDiffProvider = {
            provideOriginalResource: (uri: vscode.Uri) => {
                const relative = path.relative(this.repoRoot, uri.fsPath);
                if (!relative || relative.startsWith('..')) { return undefined; }
                return GitHeadContentProvider.makeUri(this.repoRoot, relative);
            },
        };

        this.stagedGroup = this.scm.createResourceGroup('staged', 'Staged Changes');
        this.stagedGroup.hideWhenEmpty = true;

        this.changesGroup = this.scm.createResourceGroup('changes', 'Changes');
        this.changesGroup.hideWhenEmpty = true;

        this.conflictsGroup = this.scm.createResourceGroup('conflicts', 'Conflicts (multi-session)');
        this.conflictsGroup.hideWhenEmpty = true;

        this._disposables.push(this.scm);
    }

    /** Paths currently staged for commit. */
    get stagedPaths(): ReadonlySet<string> {
        return this._stagedPaths;
    }

    /** Display the terminal name below the SCM panel title (clickable to reveal). */
    setTerminalName(name: string): void {
        this.scm.statusBarCommands = [{
            command: 'multiClaude.revealTerminal',
            title: `$(terminal) ${name}`,
            tooltip: `Reveal terminal: ${name}`,
            arguments: [this.scm],
        }];
    }

    /** Move a file from Changes/Conflicts into Staged. */
    stageFile(absPath: string): void {
        this._stagedPaths.add(absPath);
        this._saveStagedPaths();
    }

    /** Move a file from Staged back to Changes/Conflicts. */
    unstageFile(absPath: string): void {
        this._stagedPaths.delete(absPath);
        this._saveStagedPaths();
    }

    /** Stage all current Changes + Conflicts. */
    stageAll(): void {
        for (const r of this.changesGroup.resourceStates) {
            this._stagedPaths.add(r.resourceUri.fsPath);
        }
        for (const r of this.conflictsGroup.resourceStates) {
            this._stagedPaths.add(r.resourceUri.fsPath);
        }
        this._saveStagedPaths();
    }

    /** Unstage everything. */
    unstageAll(): void {
        this._stagedPaths.clear();
        this._saveStagedPaths();
    }

    /** Clear staged paths for committed files. */
    clearStagedPaths(committedAbsPaths: string[]): void {
        for (const p of committedAbsPaths) {
            this._stagedPaths.delete(p);
        }
        this._saveStagedPaths();
    }

    /** All staged file paths (for commit). */
    getStagedResourcePaths(): string[] {
        return Array.from(this._stagedPaths);
    }

    /**
     * Update the panel with current file lists.
     * Preserves staging state — files that were staged stay staged if still present.
     */
    updateResources(
        changedFiles: string[],
        conflictFiles: string[],
        untrackedPaths: Set<string>,
        deletedPaths: Set<string> = new Set(),
    ): void {
        const allCurrent = new Set([...changedFiles, ...conflictFiles]);
        // Prune staged paths that are no longer in the panel (e.g. committed)
        for (const p of this._stagedPaths) {
            if (!allCurrent.has(p)) {
                this._stagedPaths.delete(p);
            }
        }

        const stagedStates: vscode.SourceControlResourceState[] = [];
        const changeStates: vscode.SourceControlResourceState[] = [];
        const conflictStates: vscode.SourceControlResourceState[] = [];

        for (const f of changedFiles) {
            const state = this._makeResourceState(f, untrackedPaths.has(f), false, deletedPaths.has(f));
            if (this._stagedPaths.has(f)) {
                stagedStates.push(state);
            } else {
                changeStates.push(state);
            }
        }

        for (const f of conflictFiles) {
            const state = this._makeResourceState(f, untrackedPaths.has(f), true, deletedPaths.has(f));
            if (this._stagedPaths.has(f)) {
                stagedStates.push(state);
            } else {
                conflictStates.push(state);
            }
        }

        this.stagedGroup.resourceStates = stagedStates;
        this.changesGroup.resourceStates = changeStates;
        this.conflictsGroup.resourceStates = conflictStates;
        this.scm.count = changedFiles.length + conflictFiles.length;
    }

    private _makeResourceState(
        absPath: string,
        isUntracked: boolean,
        isConflict: boolean,
        isDeleted: boolean = false,
    ): vscode.SourceControlResourceState {
        const uri = vscode.Uri.file(absPath);
        const relative = absPath.slice(this.repoRoot.length + 1);
        const headUri = GitHeadContentProvider.makeUri(this.repoRoot, relative);

        let tooltip: string;
        let iconPath: vscode.ThemeIcon | undefined;
        if (isConflict) {
            tooltip = `${relative} (conflict — multiple sessions)`;
            iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        } else if (isDeleted) {
            tooltip = `${relative} (deleted)`;
        } else if (isUntracked) {
            tooltip = `${relative} (new file)`;
        } else {
            tooltip = `${relative} (modified)`;
        }

        const command: vscode.Command = isDeleted
            ? {
                title: 'Show Deleted',
                command: 'vscode.open',
                arguments: [headUri],
            }
            : {
                title: 'Show Changes',
                command: 'vscode.diff',
                arguments: [
                    headUri,
                    uri,
                    `${relative} (HEAD ↔ ${this.sessionName})`,
                ],
            };

        const state: vscode.SourceControlResourceState = {
            resourceUri: uri,
            decorations: {
                strikeThrough: isDeleted,
                tooltip,
                iconPath,
                faded: false,
            },
            command,
        };
        return state;
    }

    private _getStagedFilePath(): string {
        return path.join(this.repoRoot, STAGED_FILES_PATH);
    }

    private _loadStagedPaths(): void {
        try {
            const filePath = this._getStagedFilePath();
            if (!fs.existsSync(filePath)) { return; }
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const sessionPaths = data?.[this.sessionId];
            if (Array.isArray(sessionPaths)) {
                for (const p of sessionPaths) {
                    if (typeof p === 'string') {
                        this._stagedPaths.add(p);
                    }
                }
            }
        } catch {
            // Ignore corrupt file
        }
    }

    private _saveStagedPaths(): void {
        try {
            const filePath = this._getStagedFilePath();
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Read existing data to preserve other sessions' staged paths
            let data: Record<string, string[]> = {};
            if (fs.existsSync(filePath)) {
                try {
                    data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) ?? {};
                } catch {
                    data = {};
                }
            }

            if (this._stagedPaths.size > 0) {
                data[this.sessionId] = Array.from(this._stagedPaths);
            } else {
                delete data[this.sessionId];
            }

            // Clean up empty file
            if (Object.keys(data).length === 0) {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } else {
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
            }
        } catch {
            // Non-critical — ignore
        }
    }

    /** Clear persisted staged paths for this session (call before dispose). */
    cleanupPersistence(): void {
        this._stagedPaths.clear();
        this._saveStagedPaths();
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
    }
}
