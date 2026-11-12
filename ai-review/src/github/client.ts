import type { getOctokit } from '@actions/github';
import type { ChangedFile, PullRequest } from './pull-request.ts';

export type Octokit = ReturnType<typeof getOctokit>;

export type RepoRef = { owner: string; repo: string };

export const parseRepo = (fullName: string): RepoRef => {
    const [owner, repo, ...rest] = fullName.split('/');
    if (!owner || !repo || rest.length > 0) throw new Error(`expected owner/repo, got "${fullName}"`);
    return { owner, repo };
};

export const parsePullRequestNumber = (text: string): number => {
    if (!/^[1-9]\d*$/.test(text.trim())) throw new Error(`expected a pull request number, got "${text}"`);
    return Number(text);
};

export type PullRequestRef = { repo: RepoRef; number: number };

const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parsePullRequestRef(text: string): PullRequestRef {
    const trimmed = text.trim();
    const url = PULL_REQUEST_URL.exec(trimmed);
    if (url) return { repo: parseRepo(url[1]!), number: parsePullRequestNumber(url[2]!) };
    const [repo, number, ...rest] = trimmed.split('#');
    if (repo === undefined || number === undefined || rest.length > 0) {
        throw new Error(`expected owner/repo#number or a pull request URL, got "${text}"`);
    }
    return { repo: parseRepo(repo), number: parsePullRequestNumber(number) };
}

export const status = (error: unknown): number | undefined =>
    typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
export const isNotFound = (error: unknown): boolean => status(error) === 404;
export const isAlreadyExists = (error: unknown): boolean => status(error) === 422;

export async function fetchPullRequest(octokit: Octokit, repo: RepoRef, number: number): Promise<PullRequest> {
    const { data: pr } = await octokit.rest.pulls.get({ ...repo, pull_number: number });
    // listFiles stops at GitHub's 3000-file cap on its own.
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, { ...repo, pull_number: number, per_page: 100 });
    return {
        repo: `${repo.owner}/${repo.repo}`,
        number,
        title: pr.title,
        body: pr.body ?? '',
        author: pr.user.login,
        baseRef: pr.base.ref,
        defaultBranch: pr.base.repo.default_branch,
        headSha: pr.head.sha,
        draft: pr.draft ?? false,
        files: files.map((file): ChangedFile => ({
            path: file.filename,
            ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            ...(file.patch === undefined ? {} : { patch: file.patch }),
        })),
    };
}

export type RepoFile = { kind: 'found'; text: string } | { kind: 'missing' } | { kind: 'unreadable'; error: string };

export async function fetchFile(octokit: Octokit, repo: RepoRef, ref: string, path: string): Promise<RepoFile> {
    let data;
    try {
        ({ data } = await octokit.rest.repos.getContent({ ...repo, path, ref }));
    } catch (error) {
        if (isNotFound(error)) return { kind: 'missing' };
        throw error;
    }
    if (Array.isArray(data) || data.type !== 'file' || !('encoding' in data) || data.encoding !== 'base64') {
        return { kind: 'unreadable', error: `\`${path}\` is not a readable file of at most 1 MB` };
    }
    return { kind: 'found', text: Buffer.from(data.content, 'base64').toString('utf8') };
}
