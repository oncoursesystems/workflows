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
    type Summary,
} from './github.ts';
import { checkTitle, inlineBody, renderRoundLimit, renderSummary } from './report.ts';
import { review, type ReviewResult } from './review.ts';
import { fingerprint, MAX_ROUNDS, readState, rightSideLines, type ReviewState } from './state.ts';

export type RunOptions = {
    octokit: Octokit;
    repo: RepoRef;
    number: number;
    cwd: string;
    fresh: boolean;
    publish: boolean;
    runAgent: RunAgent;
};

export type Scope = { kind: 'full' } | { kind: 'since'; fromSha: string; files: ChangedFile[] };

export type RunOutcome =
    | { kind: 'draft' }
    | { kind: 'up-to-date'; sha: string }
    | { kind: 'round-limit'; state: ReviewState }
    | { kind: 'reviewed'; result: ReviewResult; state: ReviewState; inline: ReviewedFinding[]; outsideDiff: ReviewedFinding[]; summary: string };

export const describeScope = (scope: Scope): string =>
    scope.kind === 'full' ? 'the whole pull request' : `the changes since \`${scope.fromSha.slice(0, 7)}\``;

async function chooseScope(options: RunOptions, pr: PullRequest, previous: ReviewState | undefined): Promise<Scope> {
    if (options.fresh || previous === undefined) return { kind: 'full' };
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
    const previous = options.fresh ? undefined : readState(existing?.body);
    if (previous?.reviewedSha === pr.headSha) return { kind: 'up-to-date', sha: pr.headSha };

    if (previous !== undefined && previous.round >= MAX_ROUNDS) {
        if (options.publish) await upsertSummary(octokit, repo, number, existing, renderRoundLimit(previous));
        return { kind: 'round-limit', state: previous };
    }

    const scope = await chooseScope(options, pr, previous);
    const [labels, rules] = await Promise.all([fetchLabels(octokit, repo, number), fetchRules(octokit, repo, pr.baseRef)]);
    const result = await review(
        {
            pr,
            tier: tierFromLabels(labels),
            files: scope.kind === 'full' ? pr.files : scope.files,
            scope: describeScope(scope),
            rules,
            cwd: options.cwd,
        },
        options.runAgent,
    );

    const state: ReviewState = { reviewedSha: pr.headSha, round: (previous?.round ?? 0) + 1 };
    const { inline, outsideDiff } = splitInline(result.findings, pr);
    const summary = renderSummary({ result, state, inline, outsideDiff, scope: describeScope(scope) });
    const outcome: RunOutcome = { kind: 'reviewed', result, state, inline, outsideDiff, summary };
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
    await upsertSummary(octokit, repo, number, existing, summary);
    const nits = result.findings.filter((finding) => finding.placement === 'nit').length;
    await postCheck(octokit, repo, pr.headSha, checkTitle(inline.length, outsideDiff.length, nits), summary);
    return outcome;
}
