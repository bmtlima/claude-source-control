import { execFile } from 'child_process';

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
    try {
        await exec('git', ['rev-parse', '--is-inside-work-tree'], cwd);
        return true;
    } catch {
        return false;
    }
}

/** Returns file content at HEAD. Throws if file doesn't exist at HEAD. */
export async function gitShow(cwd: string, relativePath: string): Promise<string> {
    return exec('git', ['show', `HEAD:${relativePath}`], cwd);
}

export interface GitStatusEntry {
    /** Two-character porcelain status code, e.g. ' M', '??', 'A ' */
    status: string;
    /** Path relative to repo root */
    path: string;
}

/** Returns list of changed files from `git status --porcelain`. */
export async function gitStatusFiles(cwd: string): Promise<GitStatusEntry[]> {
    const out = await exec('git', ['status', '--porcelain', '-uall'], cwd);
    const entries: GitStatusEntry[] = [];
    for (const line of out.split('\n')) {
        if (line.length < 4) { continue; }
        entries.push({
            status: line.substring(0, 2),
            path: line.substring(3),
        });
    }
    return entries;
}

/** Restores a tracked file to its HEAD version. */
export async function gitCheckoutFile(cwd: string, relativePath: string): Promise<void> {
    await exec('git', ['checkout', 'HEAD', '--', relativePath], cwd);
}

/** Stages specific files and commits with the given message. */
export async function gitAddAndCommit(cwd: string, relativePaths: string[], message: string): Promise<void> {
    await exec('git', ['add', '--', ...relativePaths], cwd);
    await exec('git', ['commit', '-m', message], cwd);
}

/** Returns the repo root (absolute path). */
export async function gitRepoRoot(cwd: string): Promise<string> {
    const root = await exec('git', ['rev-parse', '--show-toplevel'], cwd);
    return root.trimEnd();
}
