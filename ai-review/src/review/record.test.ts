import { describe, expect, it } from 'vitest';
import type { ReviewedFinding } from './finding.ts';
import { recordName, reviewRecord } from './record.ts';
import { ReviewFailedError } from './review.ts';
import { fingerprint, fingerprintMarker } from './state.ts';
import { inlineBody } from './report.ts';

const finding = (placement: ReviewedFinding['placement'], line: number): ReviewedFinding => ({
    kind: 'security',
    file: 'src/Notes.cs',
    line,
    severity: 'minor',
    claim: `Claim ${line}.`,
    failureScenario: `Failure ${line}.`,
    verdicts: [{ real: true, introducedByPullRequest: true, severity: 'important', reason: 'r' }],
    placement,
});

const onDiff = finding('inline', 10);
const offDiff = finding('inline', 900);
const minor = finding('minor', 20);
const dropped = finding('dropped', 30);

const record = reviewRecord(
    {
        kind: 'reviewed',
        pr: { repo: 'o/r', number: 7, title: 't', body: '', author: 'dev', baseRef: 'master', defaultBranch: 'master', headSha: 'abc', draft: false, files: [] },
        scope: 'the whole pull request',
        result: { tier: 'high', findings: [onDiff, offDiff, minor, dropped], candidates: 4, agents: [], costUsd: 2.5, durationMs: 1000 },
        state: { reviewedSha: 'abc', round: 2 },
        inline: [onDiff],
        outsideDiff: [offDiff],
        summary: 's',
    },
    new Date('2026-11-07T12:00:00Z'),
);

describe('reviewRecord', () => {
    it('says where each finding was posted, dropped ones included', () => {
        expect(record.findings.map((f) => `${f.line}:${f.posted}`)).toEqual(['10:review-comment', '900:summary', '20:summary', '30:not-posted']);
    });

    it('carries the fingerprint that the review comment hides, so reactions can be joined to the finding', () => {
        expect(inlineBody(onDiff)).toContain(fingerprintMarker(record.findings[0]?.fingerprint ?? ''));
        expect(record.findings[0]?.fingerprint).toBe(fingerprint(onDiff));
    });

    it('keeps the pull request, round, tier and cost', () => {
        expect(record).toMatchObject({ version: 2, outcome: 'reviewed', repo: 'o/r', number: 7, round: 2, tier: 'high', costUsd: 2.5, finishedAt: '2026-11-07T12:00:00.000Z' });
        expect(record).not.toHaveProperty('error');
    });
});

describe('reviewRecord for a review that failed', () => {
    const pr = { repo: 'o/r', number: 7, title: 't', body: '', author: 'dev', baseRef: 'master', defaultBranch: 'master', headSha: 'abcdef1', draft: false, files: [] };
    const agent = (role: string, costUsd: number) => ({ role, model: 'claude-opus-5-5', billing: 'subscription' as const, costUsd, turns: 4, durationMs: 1, tools: {}, denied: [] });
    const failed = {
        kind: 'failed' as const,
        pr,
        scope: 'the whole pull request',
        state: { reviewedSha: 'abcdef1', round: 1, tier: 'high' as const },
        tier: 'high' as const,
        error: new ReviewFailedError(new Error('claude-opus-5-5 stopped with an error: overloaded'), [agent('finder: security', 1.25), agent('finder: correctness', 2.5)], 90_000),
    };
    const failedRecord = reviewRecord(failed, new Date('2026-11-07T12:00:00Z'));

    it('keeps the error, the agents that ran and what they spent', () => {
        expect(failedRecord).toMatchObject({
            version: 2,
            outcome: 'failed',
            error: 'claude-opus-5-5 stopped with an error: overloaded',
            tier: 'high',
            costUsd: 3.75,
            durationMs: 90_000,
            findings: [],
        });
        expect(failedRecord.agents.map((a) => a.role)).toEqual(['finder: security', 'finder: correctness']);
    });

    it('names the artifact so a failed run stands apart from a finished one', () => {
        expect(recordName(failed)).toBe('ai-review-7-round-1-abcdef1-failed');
    });
});

describe('inlineBody', () => {
    it('asks for a reaction', () => {
        expect(inlineBody(onDiff)).toContain('React 👍 if this is a real problem or 👎 if it is wrong.');
    });
});
