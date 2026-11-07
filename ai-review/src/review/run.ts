import { fetchPullRequest, type Octokit, type RepoRef } from '../risk/github.ts';
import type { ChangedFile, PullRequest } from '../risk/pull-request.ts';
import type { RunAgent } from './agent.ts';
import type { ReviewedFinding } from './finding.ts';
import {
    fetchLabels,
    fetchRules,
    filesSince,
    findSummary,
    postCheck,
    postedFingerprints,
    postInline,
    tierFromLabels,
    upsertSummary,
    waitForRiskTier,
    type Summary,
} from './github.ts';
import { checkTitle, inlineBody, renderFailed, renderRoundLimit, renderRunning, renderSummary } from './report.ts';
import { review, type ReviewResult } from './review.ts';
import { fingerprint, planRound, readState, rightSideLines, type ReviewState } from './state.ts';

export type RunOptions = {
    octokit: Octokit;
    checksOctokit: Octokit;
    repo: RepoRef;
    number: number;
    cwd: string;
    fresh: boolean;
    awaitRiskTier: boolean;
    publish: boolean;
    runAgent: RunAgent;
};

export type Scope = { kind: 'full'; reason?: string } | { kind: 'since'; fromSha: string; files: ChangedFile[] };

export type RunOutcome =
    | { kind: 'draft' }
    | { kind: 'up-to-date'; sha: string }
    | { kind: 'round-limit'; state: ReviewState }
    | {
          kind: 'reviewed';
          pr: PullRequest;
          scope: string;
          result: ReviewResult;
          state: ReviewState;
          inline: ReviewedFinding[];
          outsideDiff: ReviewedFinding[];
          summary: string;
      };

export function describeScope(scope: Scope): string {
    if (scope.kind === 'since') return `the changes since \`${scope.fromSha.slice(0, 7)}\``;
    return scope.reason === undefined ? 'the whole pull request' : `the whole pull request, because ${scope.reason}`;
}

async function chooseScope(options: RunOptions, pr: PullRequest, previous: ReviewState | undefined, reason?: string): Promise<Scope> {
    if (previous === undefined) return reason === undefined ? { kind: 'full' } : { kind: 'full', reason };
    const files = await filesSince(options.octokit, options.repo, previous.reviewedSha, pr.headSha);
    return files === undefined ? { kind: 'full' } : { kind: 'since', fromSha: previous.reviewedSha, files };
}

function splitInline(findings: readonly ReviewedFinding[], pr: PullRequest) {
    const important = findings.filter((finding) => finding.placement === 'inline');
    const linesByFile = new Map(pr.files.map((file) => [file.path, rightSideLines(file.patch)]));
    const inDiff = (finding: ReviewedFinding) => linesByFile.get(finding.file)?.has(finding.line) ?? false;
    return { inline: important.filter(inDiff), outsideDiff: important.filter((finding) => !inDiff(finding)) };
}

export async function runReview(options: RunOptions): Promise<RunOutcome> {
    const { octokit, repo, number } = options;
    const pr = await fetchPullRequest(octokit, repo, number);
    if (pr.draft) return { kind: 'draft' };

    const existing: Summary | undefined = await findSummary(octokit, repo, number);
    const tierSettled = options.awaitRiskTier ? await waitForRiskTier(options.checksOctokit, repo, pr.headSha) : true;
    const tier = tierFromLabels(await fetchLabels(octokit, repo, number));
    const plan = planRound(options.fresh ? undefined : readState(existing?.body), pr.headSha, tier);
    if (plan.kind === 'up-to-date') return { kind: 'up-to-date', sha: pr.headSha };
    if (plan.kind === 'round-limit') {
        if (options.publish) await upsertSummary(octokit, repo, number, existing, renderRoundLimit(plan.state));
        return { kind: 'round-limit', state: plan.state };
    }

    const { previous } = plan;
    const scope = await chooseScope(options, pr, previous, plan.restartReason);
    const state: ReviewState = { reviewedSha: pr.headSha, round: (previous?.round ?? 0) + 1, tier };
    const notes = tierSettled
        ? []
        : [`The \`risk-tier\` check had not finished, so this review used the \`risk:${tier}\` label as it was.`];
    const summaryComment = options.publish
        ? await upsertSummary(octokit, repo, number, existing, renderRunning(state, describeScope(scope), previous))
        : existing;
    let result: ReviewResult;
    try {
        const rules = await fetchRules(octokit, repo, pr.baseRef);
        result = await review(
            {
                pr,
                tier,
                files: scope.kind === 'full' ? pr.files : scope.files,
                scope: describeScope(scope),
                rules,
                cwd: options.cwd,
            },
            options.runAgent,
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.publish) await upsertSummary(octokit, repo, number, summaryComment, renderFailed(state, message, previous));
        throw error;
    }

    const { inline, outsideDiff } = splitInline(result.findings, pr);
    const summary = renderSummary({ repo: pr.repo, result, state, inline, outsideDiff, scope: describeScope(scope), notes });
    const outcome: RunOutcome = { kind: 'reviewed', pr, scope: describeScope(scope), result, state, inline, outsideDiff, summary };
    if (!options.publish) return outcome;

    const posted = await postedFingerprints(octokit, repo, number);
    const fresh = inline.filter((finding) => !posted.has(fingerprint(finding)));
    await postInline(
        octokit,
        repo,
        number,
        pr.headSha,
        fresh.map((finding) => ({ path: finding.file, line: finding.line, body: inlineBody(finding) })),
    );
    await upsertSummary(octokit, repo, number, summaryComment, summary);
    const minor = result.findings.filter((finding) => finding.placement === 'minor').length;
    await postCheck(options.checksOctokit, repo, pr.headSha, checkTitle(inline.length + outsideDiff.length, minor), summary);
    return outcome;
}
