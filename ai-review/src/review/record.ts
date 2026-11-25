import type { ReviewedFinding } from './finding.ts';
import type { AgentReport } from './review.ts';
import type { RunOutcome } from './run.ts';
import { fingerprint } from './state.ts';

export type Posted = 'review-comment' | 'summary' | 'not-posted';

export type RecordedFinding = ReviewedFinding & { fingerprint: string; posted: Posted };

export type ReviewRecord = {
    version: 2;
    outcome: 'reviewed' | 'failed';
    error?: string;
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

export type RecordedOutcome = Extract<RunOutcome, { kind: 'reviewed' | 'failed' }>;

export function reviewRecord(outcome: RecordedOutcome, finishedAt: Date): ReviewRecord {
    const { pr, state } = outcome;
    const head = {
        version: 2 as const,
        repo: pr.repo,
        number: pr.number,
        author: pr.author,
        baseRef: pr.baseRef,
        reviewedSha: state.reviewedSha,
        round: state.round,
        scope: outcome.scope,
        finishedAt: finishedAt.toISOString(),
    };
    if (outcome.kind === 'failed') {
        const { agents, durationMs, message } = outcome.error;
        const costUsd = agents.reduce((sum, agent) => sum + agent.costUsd, 0);
        return { ...head, outcome: 'failed', error: message, tier: outcome.tier, candidates: 0, costUsd, durationMs, findings: [], agents };
    }
    const { result } = outcome;
    const posted = (finding: ReviewedFinding): Posted => {
        if (outcome.inline.includes(finding)) return 'review-comment';
        return finding.placement === 'dropped' ? 'not-posted' : 'summary';
    };
    return {
        ...head,
        outcome: 'reviewed',
        tier: result.tier,
        candidates: result.candidates,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        findings: result.findings.map((finding) => ({ ...finding, fingerprint: fingerprint(finding), posted: posted(finding) })),
        agents: result.agents,
    };
}

export const recordName = (outcome: RecordedOutcome): string =>
    `ai-review-${outcome.pr.number}-round-${outcome.state.round}-${outcome.state.reviewedSha.slice(0, 7)}${outcome.kind === 'failed' ? '-failed' : ''}`;
