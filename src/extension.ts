import * as vscode from 'vscode';
import { URI_SCHEME } from './constants';
import { isGitRepo, gitRepoRoot } from './gitUtils';
import { GitHeadContentProvider } from './gitHeadContentProvider';
import { installHook, ensureGitignore } from './hookInstaller';
import { AttributionLog } from './attributionLog';
import { ConflictTracker } from './conflictTracker';
import { SessionManager } from './sessionManager';
import { ClaudeFileDecorationProvider } from './fileDecorationProvider';

let sessionManager: SessionManager | undefined;
let gitHeadProvider: GitHeadContentProvider | undefined;
let fileDecorationProvider: ClaudeFileDecorationProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) { return; }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    if (!(await isGitRepo(workspaceRoot))) { return; }
    const repoRoot = await gitRepoRoot(workspaceRoot);

    // Register content provider for diffs against HEAD
    gitHeadProvider = new GitHeadContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(URI_SCHEME, gitHeadProvider)
    );

    // Install hook (idempotent) and ensure runtime files are gitignored
    try {
        await installHook(repoRoot);
        ensureGitignore(repoRoot);
    } catch (err) {
        console.warn('Multi-Claude: Failed to install hook:', err);
    }

    // Create attribution log watcher
    const attributionLog = new AttributionLog(repoRoot);
    context.subscriptions.push(attributionLog);

    // Create conflict tracker
    const conflictTracker = new ConflictTracker();
    context.subscriptions.push(conflictTracker);

    // Create file decoration provider
    fileDecorationProvider = new ClaudeFileDecorationProvider();
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(fileDecorationProvider),
        fileDecorationProvider
    );

    // Create session manager
    sessionManager = new SessionManager(repoRoot, attributionLog, conflictTracker, fileDecorationProvider);
    context.subscriptions.push(sessionManager);

    // Register tree view in the Source Control sidebar
    const treeView = vscode.window.createTreeView('multiClaude.sessions', {
        treeDataProvider: sessionManager.sessionTreeProvider,
    });
    context.subscriptions.push(treeView);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('multiClaude.discardFile', (resourceState: vscode.SourceControlResourceState) => {
            sessionManager?.discardFile(resourceState.resourceUri);
        }),
        vscode.commands.registerCommand('multiClaude.discardAll', (arg: vscode.SourceControl | vscode.SourceControlResourceGroup) => {
            if ('resourceStates' in arg) {
                // Called from scm/resourceGroup/context — arg is a SourceControlResourceGroup
                sessionManager?.discardAllFromGroup(arg);
            } else {
                // Called from scm/title — arg is a SourceControl
                sessionManager?.discardAll(arg);
            }
        }),
        vscode.commands.registerCommand('multiClaude.setupHook', async () => {
            try {
                await installHook(repoRoot);
                vscode.window.showInformationMessage('Multi-Claude: Hook installed successfully.');
            } catch (err) {
                vscode.window.showErrorMessage(`Multi-Claude: Failed to install hook: ${err}`);
            }
        }),
        vscode.commands.registerCommand('multiClaude.refresh', () => {
            sessionManager?.refresh();
        }),
        vscode.commands.registerCommand('multiClaude.commitSession', (panel: unknown) => {
            sessionManager?.commitSession(panel as any);
        }),
        vscode.commands.registerCommand('multiClaude.commit', (sourceControl: vscode.SourceControl) => {
            sessionManager?.commitFromScm(sourceControl);
        }),
        vscode.commands.registerCommand('multiClaude.stageFile', (resourceState: vscode.SourceControlResourceState) => {
            sessionManager?.stageFile(resourceState);
        }),
        vscode.commands.registerCommand('multiClaude.unstageFile', (resourceState: vscode.SourceControlResourceState) => {
            sessionManager?.unstageFile(resourceState);
        }),
        vscode.commands.registerCommand('multiClaude.stageAll', (group: vscode.SourceControlResourceGroup) => {
            sessionManager?.stageAll(group);
        }),
        vscode.commands.registerCommand('multiClaude.unstageAll', (group: vscode.SourceControlResourceGroup) => {
            sessionManager?.unstageAll(group);
        }),
        vscode.commands.registerCommand('multiClaude.dismissSession', (sourceControl: vscode.SourceControl) => {
            sessionManager?.dismissSession(sourceControl);
        }),
        vscode.commands.registerCommand('multiClaude.revealTerminal', (sourceControl: vscode.SourceControl) => {
            sessionManager?.revealTerminal(sourceControl);
        }),
        vscode.commands.registerCommand('multiClaude.showSessionPanel', (sessionId: string) => {
            sessionManager?.showSessionPanel(sessionId);
        }),
        vscode.commands.registerCommand('multiClaude.showAllPanels', () => {
            sessionManager?.showAllPanels();
        }),
        vscode.commands.registerCommand('multiClaude.hideSessionPanel', (sessionId: string) => {
            sessionManager?.hideSessionPanel(sessionId);
        }),
    );
}

export function deactivate(): void {
    sessionManager?.dispose();
    gitHeadProvider?.dispose();
}
