import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ATTRIBUTION_LOG } from './constants';

export interface AttributionEntry {
    session_id: string;
    file_path: string;
    tool_name: string;
    timestamp: number;
}

/**
 * Watches .claude/file-attribution.jsonl and maintains a session→files map.
 * Uses incremental reads (tracks byte offset) for efficiency.
 */
export class AttributionLog implements vscode.Disposable {
    private _sessionFiles = new Map<string, Set<string>>();
    private _sessionLastTimestamp = new Map<string, number>();
    private _byteOffset = 0;
    private _logPath: string;
    private _watcher: fs.FSWatcher | null = null;
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    private _disposed = false;

    constructor(private readonly workspaceRoot: string) {
        this._logPath = path.join(workspaceRoot, ATTRIBUTION_LOG);
        this._initialRead();
        this._startWatching();
    }

    /** Map from session_id → set of absolute file paths. */
    get sessionFiles(): ReadonlyMap<string, Set<string>> {
        return this._sessionFiles;
    }

    /** All session IDs seen so far. */
    get sessionIds(): string[] {
        return Array.from(this._sessionFiles.keys());
    }

    /** Last-seen timestamp per session (from JSONL entry timestamps). */
    get sessionLastTimestamp(): ReadonlyMap<string, number> {
        return this._sessionLastTimestamp;
    }

    /** Files attributed to a specific session. */
    filesForSession(sessionId: string): Set<string> {
        return this._sessionFiles.get(sessionId) ?? new Set();
    }

    private _initialRead(): void {
        if (!fs.existsSync(this._logPath)) { return; }
        try {
            const content = fs.readFileSync(this._logPath, 'utf-8');
            this._byteOffset = Buffer.byteLength(content, 'utf-8');
            this._parseLines(content);
        } catch {
            // File may not exist yet — that's fine
        }
    }

    private _startWatching(): void {
        const dir = path.dirname(this._logPath);

        // Ensure .claude dir exists before watching
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        try {
            this._watcher = fs.watch(dir, (eventType, filename) => {
                if (this._disposed) { return; }
                if (filename === path.basename(this._logPath)) {
                    this._readIncremental();
                }
            });
        } catch {
            // Watch may fail on some platforms — fall back to polling
        }
    }

    private _readIncremental(): void {
        try {
            const stat = fs.statSync(this._logPath);
            if (stat.size <= this._byteOffset) {
                if (stat.size < this._byteOffset) {
                    // File was truncated — re-read from start
                    this._sessionFiles.clear();
                    this._byteOffset = 0;
                } else {
                    return; // No new data
                }
            }

            const fd = fs.openSync(this._logPath, 'r');
            try {
                const buf = Buffer.alloc(stat.size - this._byteOffset);
                fs.readSync(fd, buf, 0, buf.length, this._byteOffset);
                this._byteOffset = stat.size;
                const newContent = buf.toString('utf-8');
                if (this._parseLines(newContent)) {
                    this._onDidChange.fire();
                }
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            // File might have been deleted between stat and open
        }
    }

    /** Returns true if any new entries were parsed. */
    private _parseLines(content: string): boolean {
        let changed = false;
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) { continue; }
            try {
                const entry: AttributionEntry = JSON.parse(trimmed);
                if (!entry.session_id || !entry.file_path) { continue; }

                let files = this._sessionFiles.get(entry.session_id);
                if (!files) {
                    files = new Set();
                    this._sessionFiles.set(entry.session_id, files);
                }
                // Normalize to absolute path
                const absPath = path.isAbsolute(entry.file_path)
                    ? entry.file_path
                    : path.join(this.workspaceRoot, entry.file_path);
                files.add(absPath);
                // Track last-seen timestamp per session
                if (entry.timestamp) {
                    const prev = this._sessionLastTimestamp.get(entry.session_id) ?? 0;
                    if (entry.timestamp > prev) {
                        this._sessionLastTimestamp.set(entry.session_id, entry.timestamp);
                    }
                }
                changed = true;
            } catch {
                // Skip malformed lines
            }
        }
        return changed;
    }

    /**
     * Transfer attribution from an old path to a new path (for renames).
     * All sessions that had the old path will now also have the new path.
     */
    transferAttribution(oldAbsPath: string, newAbsPath: string): void {
        for (const [, files] of this._sessionFiles) {
            if (files.has(oldAbsPath)) {
                files.delete(oldAbsPath);
                files.add(newAbsPath);
            }
        }
    }

    /**
     * Prune entries for files that are no longer uncommitted.
     * Rewrites the JSONL keeping only entries whose file_path is in uncommittedPaths.
     * Also cleans up the in-memory sessionFiles map.
     */
    pruneEntries(uncommittedAbsPaths: Set<string>): void {
        // Prune in-memory map
        let pruned = false;
        for (const [sessionId, files] of this._sessionFiles) {
            for (const f of files) {
                if (!uncommittedAbsPaths.has(f)) {
                    files.delete(f);
                    pruned = true;
                }
            }
            if (files.size === 0) {
                this._sessionFiles.delete(sessionId);
                this._sessionLastTimestamp.delete(sessionId);
            }
        }

        if (!pruned) { return; }

        // Rewrite the JSONL file keeping only relevant entries
        try {
            if (!fs.existsSync(this._logPath)) { return; }
            const content = fs.readFileSync(this._logPath, 'utf-8');
            const keptLines: string[] = [];
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) { continue; }
                try {
                    const entry: AttributionEntry = JSON.parse(trimmed);
                    if (!entry.session_id || !entry.file_path) { continue; }
                    const absPath = path.isAbsolute(entry.file_path)
                        ? entry.file_path
                        : path.join(this.workspaceRoot, entry.file_path);
                    if (uncommittedAbsPaths.has(absPath)) {
                        keptLines.push(trimmed);
                    }
                } catch {
                    // Skip malformed lines
                }
            }
            const newContent = keptLines.length > 0
                ? keptLines.join('\n') + '\n'
                : '';
            fs.writeFileSync(this._logPath, newContent);
            this._byteOffset = Buffer.byteLength(newContent, 'utf-8');
        } catch {
            // If rewrite fails, leave file as-is
        }
    }

    /** Remove all data for a session (in-memory + JSONL). */
    removeSession(sessionId: string): void {
        this._sessionFiles.delete(sessionId);
        this._sessionLastTimestamp.delete(sessionId);

        // Rewrite JSONL without this session's entries
        try {
            if (!fs.existsSync(this._logPath)) { return; }
            const content = fs.readFileSync(this._logPath, 'utf-8');
            const keptLines: string[] = [];
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) { continue; }
                try {
                    const entry: AttributionEntry = JSON.parse(trimmed);
                    if (entry.session_id === sessionId) { continue; }
                    keptLines.push(trimmed);
                } catch {
                    // Skip malformed lines
                }
            }
            const newContent = keptLines.length > 0
                ? keptLines.join('\n') + '\n'
                : '';
            fs.writeFileSync(this._logPath, newContent);
            this._byteOffset = Buffer.byteLength(newContent, 'utf-8');
        } catch {
            // If rewrite fails, leave file as-is
        }
    }

    dispose(): void {
        this._disposed = true;
        this._watcher?.close();
        this._onDidChange.dispose();
    }
}
