import type { getOctokit } from '@actions/github';
import type { Classification } from './classify.ts';
import { missingLabels, reconcileRiskLabels } from './labels.ts';
import { lookupPolicy, missingPolicy, type PolicyLookup } from './policy.ts';
import type { ChangedFile, PullRequest } from './pull-request.ts';
import { checkTitle, renderSummary } from './report.ts';

export type Octokit = ReturnType<typeof getOctokit>;

export const DEFAULT_POLICY_PATH = 'review-policy.yml';

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

const status = (error: unknown): number | undefined =>
    typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
const isNotFound = (error: unknown): boolean => status(error) === 404;
const isAlreadyExists = (error: unknown): boolean => status(error) === 422;

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

export async function fetchPolicy(octokit: Octokit, repo: RepoRef, baseRef: string, path: string): Promise<PolicyLookup> {
    let data;
    try {
        ({ data } = await octokit.rest.repos.getContent({ ...repo, path, ref: baseRef }));
    } catch (error) {
        if (isNotFound(error)) return missingPolicy(baseRef);
        throw error;
    }
    if (Array.isArray(data) || data.type !== 'file' || !('encoding' in data) || data.encoding !== 'base64') {
        return { kind: 'invalid', ref: baseRef, error: `\`${path}\` is not a readable file of at most 1 MB` };
    }
    return lookupPolicy(Buffer.from(data.content, 'base64').toString('utf8'), baseRef);
}

async function ensureLabels(octokit: Octokit, repo: RepoRef): Promise<void> {
    const existing = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, { ...repo, per_page: 100 });
    for (const label of missingLabels(existing.map((l) => l.name))) {
        try {
            await octokit.rest.issues.createLabel({ ...repo, ...label });
        } catch (error) {
            if (!isAlreadyExists(error)) throw error;
        }
    }
}

async function setRiskLabel(octokit: Octokit, repo: RepoRef, pr: PullRequest, classification: Classification) {
    const { data: labels } = await octokit.rest.issues.listLabelsOnIssue({ ...repo, issue_number: pr.number, per_page: 100 });
    const change = reconcileRiskLabels(labels.map((l) => l.name), classification.tier);
    if (change.add.length > 0) {
        await octokit.rest.issues.addLabels({ ...repo, issue_number: pr.number, labels: change.add });
    }
    for (const name of change.remove) {
        try {
            await octokit.rest.issues.removeLabel({ ...repo, issue_number: pr.number, name });
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
    }
}

export async function publish(octokit: Octokit, repo: RepoRef, pr: PullRequest, classification: Classification) {
    await ensureLabels(octokit, repo);
    await setRiskLabel(octokit, repo, pr, classification);
    await octokit.rest.checks.create({
        ...repo,
        name: 'risk-tier',
        head_sha: pr.headSha,
        status: 'completed',
        conclusion: 'neutral',
        output: { title: checkTitle(classification.tier), summary: renderSummary(classification) },
    });
}
