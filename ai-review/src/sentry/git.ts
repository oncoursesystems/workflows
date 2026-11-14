import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Change } from './fix.ts';
import { insideRoots } from './fix.ts';
import type { ChangedFile } from './handoff.ts';

export type Git = (args: readonly string[]) => string;

export function gitEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
    return {
        ...(source['PATH'] === undefined ? {} : { PATH: source['PATH'] }),
        ...(source['HOME'] === undefined ? {} : { HOME: source['HOME'] }),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
    };
}

// A git dir the fixer planted at a gitlink path would make git run its config, so git on the runner never looks
// inside a submodule.
export const GIT_SAFETY = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'diff.ignoreSubmodules=all',
    '-c',
    'status.submoduleSummary=false',
];

export const gitIn =
    (cwd: string, source: Readonly<Record<string, string | undefined>> = process.env): Git =>
    (args) =>
        execFileSync('git', [...GIT_SAFETY, ...args], { cwd, env: gitEnv(source), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export type StatusEntry = { kind: 'tracked'; path: string; status: Change['status']; mode: string } | { kind: 'untracked'; path: string };

const WORKTREE_STATUS: Record<string, Change['status']> = { M: 'modified', T: 'modified', D: 'deleted' };

export function parseStatus(raw: string): StatusEntry[] {
    const entries: StatusEntry[] = [];
    for (const record of raw.split('\0')) {
        if (record === '') continue;
        if (record.startsWith('? ')) {
            entries.push({ kind: 'untracked', path: record.slice(2) });
            continue;
        }
        const fields = record.split(' ');
        const [type, xy = '', , , , modeWorktree = ''] = fields;
        const status = WORKTREE_STATUS[xy[1] ?? ''];
        if (type !== '1' || xy[0] !== '.' || status === undefined) throw new Error(`unexpected git status entry: ${record}`);
        entries.push({ kind: 'tracked', path: fields.slice(8).join(' '), status, mode: modeWorktree });
    }
    return entries;
}

const statusOf = (git: Git): StatusEntry[] => parseStatus(git(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all']));

export function attributePaths(tracked: readonly string[]): string[] {
    const dirs = new Set<string>(['.']);
    for (const path of tracked) {
        for (let dir = dirname(path); dir !== '.' && !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
    }
    return [...dirs].sort().map((dir) => (dir === '.' ? '.gitattributes' : `${dir}/.gitattributes`));
}

async function fingerprint(path: string): Promise<string> {
    let stats;
    try {
        stats = await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
        throw error;
    }
    if (stats.isSymbolicLink()) return `link ${await readlink(path)}`;
    if (stats.isDirectory()) return `directory ${JSON.stringify((await readdir(path)).sort())}`;
    if (!stats.isFile()) return 'other';
    return createHash('sha256').update(await readFile(path)).digest('hex');
}

const GITLINK_MODE = '160000';

export function parseGitlinks(raw: string): string[] {
    return raw.split('\0').flatMap((record) => {
        const tab = record.indexOf('\t');
        return tab !== -1 && record.startsWith(`${GITLINK_MODE} `) ? [record.slice(tab + 1)] : [];
    });
}

export type GitSnapshot = { fingerprints: Map<string, string>; untracked: Set<string> };

const fingerprints = async (cwd: string, paths: readonly string[]): Promise<Map<string, string>> =>
    new Map(await Promise.all(paths.map(async (path) => [path, await fingerprint(join(cwd, path))] as const)));

export async function snapshot(git: Git, cwd: string): Promise<GitSnapshot> {
    const tracked = git(['ls-files', '-z']).split('\0').filter((path) => path !== '');
    const gitlinks = parseGitlinks(git(['ls-files', '-s', '-z']));
    const untracked = statusOf(git).flatMap((entry) => (entry.kind === 'untracked' ? [entry.path] : []));
    const paths = ['.git/config', ...attributePaths(tracked), ...gitlinks.flatMap((path) => [path, `${path}/.git`])];
    return { fingerprints: await fingerprints(cwd, paths), untracked: new Set(untracked) };
}

export async function tamperedPaths(cwd: string, before: GitSnapshot): Promise<string[]> {
    const after = await fingerprints(cwd, [...before.fingerprints.keys()]);
    return [...before.fingerprints].filter(([path, print]) => after.get(path) !== print).map(([path]) => path);
}

const FILE_MODE = (executable: boolean): string => (executable ? '100755' : '100644');

async function readRegular(cwd: string, path: string): Promise<{ mode: string; content: string | null }> {
    const full = join(cwd, path);
    const stats = await lstat(full);
    if (stats.isSymbolicLink()) return { mode: '120000', content: null };
    if (stats.isDirectory()) return { mode: '160000', content: null };
    if (!stats.isFile()) return { mode: '000000', content: null };
    if ((await realpath(full)) !== join(await realpath(cwd), path)) return { mode: '120000', content: null };
    return { mode: FILE_MODE((stats.mode & 0o111) !== 0), content: (await readFile(full)).toString('base64') };
}

export async function collectChanges(git: Git, cwd: string, before: GitSnapshot, roots: readonly string[]): Promise<ChangedFile[]> {
    const changes: ChangedFile[] = [];
    for (const entry of statusOf(git)) {
        if (entry.kind === 'untracked') {
            const path = entry.path.replace(/\/$/, '');
            if (before.untracked.has(entry.path) || !insideRoots(path, roots)) continue;
            changes.push({ path, status: 'added', ...(await readRegular(cwd, entry.path)) });
        } else if (entry.status === 'deleted') {
            changes.push({ path: entry.path, status: 'deleted', mode: '000000', content: null });
        } else {
            const file = await readRegular(cwd, entry.path);
            changes.push({ path: entry.path, status: entry.status, ...file });
        }
    }
    return changes;
}
