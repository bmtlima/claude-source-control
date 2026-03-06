import * as vscode from 'vscode';

export type FileState = 'modified' | 'added' | 'deleted' | 'conflict';

interface FileStateEntry {
    state: FileState;
    sessionNames: string[];
}

export class ClaudeFileDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private _fileStates = new Map<string, FileStateEntry>();

    updateFileStates(states: Map<string, FileStateEntry>): void {
        this._fileStates = states;
        this._onDidChangeFileDecorations.fire(undefined);
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const entry = this._fileStates.get(uri.fsPath);
        if (!entry) { return undefined; }

        switch (entry.state) {
            case 'modified':
                return {
                    badge: 'M',
                    color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
                    tooltip: `Modified by ${entry.sessionNames.join(', ')}`,
                };
            case 'added':
                return {
                    badge: 'A',
                    color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
                    tooltip: `Added by ${entry.sessionNames.join(', ')}`,
                };
            case 'deleted':
                return {
                    badge: 'D',
                    color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
                    tooltip: `Deleted by ${entry.sessionNames.join(', ')}`,
                };
            case 'conflict':
                return {
                    badge: 'C',
                    color: new vscode.ThemeColor('list.warningForeground'),
                    tooltip: `Conflict — modified by ${entry.sessionNames.join(', ')}`,
                };
        }
    }

    dispose(): void {
        this._onDidChangeFileDecorations.dispose();
    }
}
