import { fetchFile, type Octokit, type RepoRef } from '../github/client.ts';
import { applyLabelChange, ensureLabels, listLabelNames } from '../github/labels.ts';
import type { PullRequest } from '../github/pull-request.ts';
import type { Classification } from './classify.ts';
import { ALL_LABELS, reconcileRiskLabels } from './labels.ts';
import { lookupPolicy, missingPolicy, type PolicyLookup } from './policy.ts';
import { checkTitle, renderSummary } from './report.ts';

export const DEFAULT_POLICY_PATH = 'review-policy.yml';

export async function fetchPolicy(octokit: Octokit, repo: RepoRef, baseRef: string, path: string): Promise<PolicyLookup> {
    const file = await fetchFile(octokit, repo, baseRef, path);
    switch (file.kind) {
        case 'missing':
            return missingPolicy(baseRef);
        case 'unreadable':
            return { kind: 'invalid', ref: baseRef, error: file.error };
        case 'found':
            return lookupPolicy(file.text, baseRef);
    }
}

export async function publish(octokit: Octokit, repo: RepoRef, pr: PullRequest, classification: Classification) {
    await ensureLabels(octokit, repo, ALL_LABELS);
    const current = await listLabelNames(octokit, repo, pr.number);
    await applyLabelChange(octokit, repo, pr.number, reconcileRiskLabels(current, classification.tier));
    await octokit.rest.checks.create({
        ...repo,
        name: 'risk-tier',
        head_sha: pr.headSha,
        status: 'completed',
        conclusion: 'neutral',
        output: { title: checkTitle(classification.tier), summary: renderSummary(classification) },
    });
}
