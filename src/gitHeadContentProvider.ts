import * as vscode from 'vscode';
import { gitShow } from './gitUtils';
import { URI_SCHEME } from './constants';

/**
 * Provides file content at HEAD for the left side of diffs.
 * URI format: multi-claude-git:/<relative-path>?repoRoot=<encoded-root>
 * For new files (untracked), returns empty string.
 */
export class GitHeadContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const relativePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
        const params = new URLSearchParams(uri.query);
        const repoRoot = params.get('repoRoot');
        if (!repoRoot || !relativePath) {
            return '';
        }
        try {
            return await gitShow(repoRoot, relativePath);
        } catch {
            // File doesn't exist at HEAD (new/untracked file)
            return '';
        }
    }

    fireChange(uri: vscode.Uri): void {
        this._onDidChange.fire(uri);
    }

    static makeUri(repoRoot: string, relativePath: string): vscode.Uri {
        return vscode.Uri.parse(
            `${URI_SCHEME}:/${relativePath}?repoRoot=${encodeURIComponent(repoRoot)}`
        );
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
