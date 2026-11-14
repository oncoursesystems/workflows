import { fetchFile, type Octokit, type RepoRef } from '../github/client.ts';
import { parseConfig, type SentryFixConfig } from './config.ts';
import type { AutoFixPr } from './eligibility.ts';
import { LABELS, markedIssueId } from './markers.ts';
import type { OpenPr } from './triage.ts';

export type ConfigLookup = { kind: 'found'; config: SentryFixConfig } | { kind: 'missing' } | { kind: 'invalid'; error: string };

export async function fetchConfig(octokit: Octokit, repo: RepoRef, ref: string, path: string): Promise<ConfigLookup> {
    const file = await fetchFile(octokit, repo, ref, path);
    if (file.kind === 'missing') return { kind: 'missing' };
    if (file.kind === 'unreadable') return { kind: 'invalid', error: file.error };
    const parsed = parseConfig(file.text);
    return parsed.ok ? { kind: 'found', config: parsed.config } : { kind: 'invalid', error: parsed.error };
}

export async function requireConfig(octokit: Octokit, repo: RepoRef, ref: string, path: string): Promise<SentryFixConfig> {
    const lookup = await fetchConfig(octokit, repo, ref, path);
    if (lookup.kind === 'missing') throw new Error(`\`${path}\` does not exist on \`${ref}\`.`);
    if (lookup.kind === 'invalid') throw new Error(`\`${path}\` on \`${ref}\` is invalid: ${lookup.error}`);
    return lookup.config;
}

export async function defaultBranchHead(octokit: Octokit, repo: RepoRef): Promise<{ branch: string; sha: string }> {
    const { data } = await octokit.rest.repos.get({ ...repo });
    const { data: branch } = await octokit.rest.repos.getBranch({ ...repo, branch: data.default_branch });
    return { branch: data.default_branch, sha: branch.commit.sha };
}

type IssueItem = { number: number; state: string; body?: string | null; labels: Array<string | { name?: string }>; pull_request?: { merged_at?: string | null } };

export const labelNames = (labels: IssueItem['labels']): string[] =>
    labels.flatMap((label) => (typeof label === 'string' ? [label] : label.name ? [label.name] : []));

export function toAutoFixPr(item: IssueItem): AutoFixPr | undefined {
    const sentryIssueId = markedIssueId(item.body);
    if (item.pull_request === undefined || sentryIssueId === undefined) return undefined;
    const state = item.state === 'open' ? 'open' : item.pull_request.merged_at ? 'merged' : 'closed';
    return { number: item.number, sentryIssueId, state, labels: labelNames(item.labels) };
}

export async function listAutoFixPrs(octokit: Octokit, repo: RepoRef): Promise<AutoFixPr[]> {
    const items = await octokit.paginate(octokit.rest.issues.listForRepo, { ...repo, labels: LABELS.autofix.name, state: 'all', per_page: 100 });
    return items.flatMap((item) => toAutoFixPr(item) ?? []);
}

export type OpenPrSummary = { number: number; title: string; body: string };

export async function listOpenPrs(octokit: Octokit, repo: RepoRef): Promise<OpenPrSummary[]> {
    const prs = await octokit.paginate(octokit.rest.pulls.list, { ...repo, state: 'open', per_page: 100 });
    return prs.map((pr) => ({ number: pr.number, title: pr.title, body: pr.body ?? '' }));
}

export function openPrsWithFiles(octokit: Octokit, repo: RepoRef, prs: readonly OpenPrSummary[]): () => Promise<OpenPr[]> {
    let loaded: Promise<OpenPr[]> | undefined;
    const load = async (): Promise<OpenPr[]> => {
        const withFiles: OpenPr[] = [];
        // One pull request at a time keeps clear of GitHub's secondary rate limit.
        for (const pr of prs) {
            const files = await octokit.paginate(octokit.rest.pulls.listFiles, { ...repo, pull_number: pr.number, per_page: 100 });
            withFiles.push({
                ...pr,
                files: files.map((file) => ({
                    path: file.filename,
                    status: file.status,
                    additions: file.additions,
                    deletions: file.deletions,
                    ...(file.patch === undefined ? {} : { patch: file.patch }),
                })),
            });
        }
        return withFiles;
    };
    return () => (loaded ??= load());
}
