import * as vscode from 'vscode';

export interface SessionInfo {
    sessionId: string;
    name: string;
    fileCount: number;
    conflictCount: number;
    hasPanel: boolean;
}

class SessionTreeItem extends vscode.TreeItem {
    constructor(public readonly info: SessionInfo) {
        super(info.name, vscode.TreeItemCollapsibleState.None);

        let desc = `${info.fileCount} file${info.fileCount !== 1 ? 's' : ''}`;
        if (info.conflictCount > 0) {
            desc += `, ${info.conflictCount} conflict${info.conflictCount !== 1 ? 's' : ''}`;
        }
        this.description = desc;

        if (info.hasPanel) {
            this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
            this.contextValue = 'sessionWithPanel';
            this.command = {
                command: 'multiClaude.hideSessionPanel',
                title: 'Hide Panel',
                arguments: [info.sessionId],
            };
        } else {
            this.iconPath = new vscode.ThemeIcon('circle-large-outline');
            this.contextValue = 'sessionWithoutPanel';
            this.command = {
                command: 'multiClaude.showSessionPanel',
                title: 'Show Panel',
                arguments: [info.sessionId],
            };
        }
    }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _sessions: SessionInfo[] = [];

    update(sessions: SessionInfo[]): void {
        this._sessions = sessions;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SessionTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): SessionTreeItem[] {
        return this._sessions.map(s => new SessionTreeItem(s));
    }
}
