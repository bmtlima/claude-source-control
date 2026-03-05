import * as vscode from 'vscode';
import { GitHeadContentProvider } from './gitHeadContentProvider';

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
            `Claude: ${sessionName}`,
        );

        // Enable commit input box
        this.scm.inputBox.placeholder = `Message (Cmd+Enter to commit "${sessionName}" staged files)`;
        this.scm.acceptInputCommand = {
            command: 'multiClaude.commitSession',
            title: 'Commit',
            arguments: [this],
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

    /** Move a file from Changes/Conflicts into Staged. */
    stageFile(absPath: string): void {
        this._stagedPaths.add(absPath);
    }

    /** Move a file from Staged back to Changes/Conflicts. */
    unstageFile(absPath: string): void {
        this._stagedPaths.delete(absPath);
    }

    /** Stage all current Changes + Conflicts. */
    stageAll(): void {
        for (const r of this.changesGroup.resourceStates) {
            this._stagedPaths.add(r.resourceUri.fsPath);
        }
        for (const r of this.conflictsGroup.resourceStates) {
            this._stagedPaths.add(r.resourceUri.fsPath);
        }
    }

    /** Unstage everything. */
    unstageAll(): void {
        this._stagedPaths.clear();
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

        // Build conflict set for reference
        const conflictSet = new Set(conflictFiles);

        for (const f of changedFiles) {
            const state = this._makeResourceState(f, untrackedPaths.has(f), false);
            if (this._stagedPaths.has(f)) {
                stagedStates.push(state);
            } else {
                changeStates.push(state);
            }
        }

        for (const f of conflictFiles) {
            const state = this._makeResourceState(f, untrackedPaths.has(f), true);
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
    ): vscode.SourceControlResourceState {
        const uri = vscode.Uri.file(absPath);
        const relative = absPath.slice(this.repoRoot.length + 1);
        const headUri = GitHeadContentProvider.makeUri(this.repoRoot, relative);

        const state: vscode.SourceControlResourceState = {
            resourceUri: uri,
            decorations: {
                strikeThrough: false,
                tooltip: isConflict
                    ? `${relative} (modified by multiple sessions)`
                    : relative,
                iconPath: isConflict
                    ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
                    : undefined,
                faded: false,
            },
            command: {
                title: 'Show Changes',
                command: 'vscode.diff',
                arguments: [
                    headUri,
                    uri,
                    `${relative} (HEAD ↔ ${this.sessionName})`,
                ],
            },
        };
        return state;
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
    }
}
