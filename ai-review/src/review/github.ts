import type { Octokit, RepoRef } from '../risk/github.ts';
import type { ChangedFile } from '../risk/pull-request.ts';
import { TIERS, type Tier } from '../risk/tier.ts';
import type { RepoRules } from './prompts.ts';
import { SUMMARY_MARKER, fingerprintsIn } from './state.ts';

const status = (error: unknown): number | undefined =>
    typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;

async function fileAt(octokit: Octokit, repo: RepoRef, path: string, ref: string): Promise<string | undefined> {
    try {
        const { data } = await octokit.rest.repos.getContent({ ...repo, path, ref });
        if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return undefined;
        return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
        if (status(error) === 404) return undefined;
        throw error;
    }
}

export async function fetchRules(octokit: Octokit, repo: RepoRef, baseRef: string): Promise<RepoRules> {
    const [claudeMd, reviewMd] = await Promise.all([
        fileAt(octokit, repo, 'CLAUDE.md', baseRef),
        fileAt(octokit, repo, 'REVIEW.md', baseRef),
    ]);
    return { ...(claudeMd === undefined ? {} : { claudeMd }), ...(reviewMd === undefined ? {} : { reviewMd }) };
}

export const DEFAULT_TIER: Tier = 'medium';

export function tierFromLabels(labels: readonly string[]): Tier {
    return TIERS.find((tier) => labels.includes(`risk:${tier}`)) ?? DEFAULT_TIER;
}

export async function fetchLabels(octokit: Octokit, repo: RepoRef, number: number): Promise<string[]> {
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, { ...repo, issue_number: number, per_page: 100 });
    return labels.map((label) => label.name);
}

export type Summary = { id: number; body: string };

export async function findSummary(octokit: Octokit, repo: RepoRef, number: number): Promise<Summary | undefined> {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...repo, issue_number: number, per_page: 100 });
    const found = comments.find((comment) => comment.user?.type === 'Bot' && comment.body?.startsWith(SUMMARY_MARKER));
    return found?.body === undefined ? undefined : { id: found.id, body: found.body };
}

export async function filesSince(octokit: Octokit, repo: RepoRef, fromSha: string, toSha: string): Promise<ChangedFile[] | undefined> {
    try {
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${fromSha}...${toSha}` });
        if (data.status === 'diverged' || data.status === 'behind') return undefined;
        return (data.files ?? []).map((file) => ({
            path: file.filename,
            ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            ...(file.patch === undefined ? {} : { patch: file.patch }),
        }));
    } catch (error) {
        if (status(error) === 404) return undefined;
        throw error;
    }
}

export async function postedFingerprints(octokit: Octokit, repo: RepoRef, number: number): Promise<Set<string>> {
    const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, { ...repo, pull_number: number, per_page: 100 });
    return fingerprintsIn(comments.map((comment) => comment.body));
}

export async function upsertSummary(
    octokit: Octokit,
    repo: RepoRef,
    number: number,
    existing: Summary | undefined,
    body: string,
): Promise<Summary> {
    if (existing === undefined) {
        const { data } = await octokit.rest.issues.createComment({ ...repo, issue_number: number, body });
        return { id: data.id, body };
    }
    if (existing.body !== body) await octokit.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
    return { id: existing.id, body };
}

export type InlineComment = { path: string; line: number; body: string };

export async function postInline(octokit: Octokit, repo: RepoRef, number: number, headSha: string, comments: InlineComment[]) {
    if (comments.length === 0) return;
    await octokit.rest.pulls.createReview({
        ...repo,
        pull_number: number,
        commit_id: headSha,
        event: 'COMMENT',
        comments: comments.map((comment) => ({ ...comment, side: 'RIGHT' as const })),
    });
}

export type Wait = { attempts: number; intervalMs: number; sleep: (ms: number) => Promise<void> };

const RISK_TIER_WAIT: Wait = {
    attempts: 30,
    intervalMs: 10_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function waitForRiskTier(octokit: Octokit, repo: RepoRef, headSha: string, wait = RISK_TIER_WAIT): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
        const { data } = await octokit.rest.checks.listForRef({ ...repo, ref: headSha, check_name: 'risk-tier' });
        if (data.check_runs.some((run) => run.status === 'completed')) return true;
        if (attempt >= wait.attempts) return false;
        await wait.sleep(wait.intervalMs);
    }
}

export async function postCheck(octokit: Octokit, repo: RepoRef, headSha: string, title: string, summary: string) {
    await octokit.rest.checks.create({
        ...repo,
        name: 'ai-review',
        head_sha: headSha,
        status: 'completed',
        conclusion: 'neutral',
        output: { title, summary },
    });
}
