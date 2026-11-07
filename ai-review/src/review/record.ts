import type { ReviewedFinding } from './finding.ts';
import type { AgentReport } from './review.ts';
import type { RunOutcome } from './run.ts';
import { fingerprint } from './state.ts';

export type Posted = 'review-comment' | 'summary' | 'not-posted';

export type RecordedFinding = ReviewedFinding & { fingerprint: string; posted: Posted };

export type ReviewRecord = {
    version: 1;
    repo: string;
    number: number;
    author: string;
    baseRef: string;
    reviewedSha: string;
    round: number;
    scope: string;
    tier: string;
    finishedAt: string;
    candidates: number;
    costUsd: number;
    durationMs: number;
    findings: RecordedFinding[];
    agents: AgentReport[];
};

export function reviewRecord(outcome: Extract<RunOutcome, { kind: 'reviewed' }>, finishedAt: Date): ReviewRecord {
    const { pr, result, state } = outcome;
    const posted = (finding: ReviewedFinding): Posted => {
        if (outcome.inline.includes(finding)) return 'review-comment';
        return finding.placement === 'dropped' ? 'not-posted' : 'summary';
    };
    return {
        version: 1,
        repo: pr.repo,
        number: pr.number,
        author: pr.author,
        baseRef: pr.baseRef,
        reviewedSha: state.reviewedSha,
        round: state.round,
        scope: outcome.scope,
        tier: result.tier,
        finishedAt: finishedAt.toISOString(),
        candidates: result.candidates,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        findings: result.findings.map((finding) => ({ ...finding, fingerprint: fingerprint(finding), posted: posted(finding) })),
        agents: result.agents,
    };
}
