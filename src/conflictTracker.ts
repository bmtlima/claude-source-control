import * as vscode from 'vscode';

/**
 * Tracks which files are modified by multiple sessions.
 * A file is "conflicted" if 2+ sessions have touched it.
 */
export class ConflictTracker implements vscode.Disposable {
    private _fileToSessions = new Map<string, Set<string>>();
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    /**
     * Update the full set of files for a session.
     * Call this on every refresh with the current attributed+uncommitted files.
     */
    update(sessionId: string, files: Set<string>): void {
        // Remove old entries for this session
        for (const [filePath, sessions] of this._fileToSessions) {
            sessions.delete(sessionId);
            if (sessions.size === 0) {
                this._fileToSessions.delete(filePath);
            }
        }

        // Add new entries
        for (const filePath of files) {
            let sessions = this._fileToSessions.get(filePath);
            if (!sessions) {
                sessions = new Set();
                this._fileToSessions.set(filePath, sessions);
            }
            sessions.add(sessionId);
        }

        this._onDidChange.fire();
    }

    /** Remove a session entirely (e.g., when its panel is disposed). */
    removeSession(sessionId: string): void {
        for (const [filePath, sessions] of this._fileToSessions) {
            sessions.delete(sessionId);
            if (sessions.size === 0) {
                this._fileToSessions.delete(filePath);
            }
        }
        this._onDidChange.fire();
    }

    /** Returns the set of file paths that are conflicts for the given session. */
    getConflictsFor(sessionId: string): Set<string> {
        const result = new Set<string>();
        for (const [filePath, sessions] of this._fileToSessions) {
            if (sessions.has(sessionId) && sessions.size > 1) {
                result.add(filePath);
            }
        }
        return result;
    }

    /** Total number of conflicted files across all sessions. */
    get conflictCount(): number {
        let count = 0;
        for (const sessions of this._fileToSessions.values()) {
            if (sessions.size > 1) { count++; }
        }
        return count;
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
