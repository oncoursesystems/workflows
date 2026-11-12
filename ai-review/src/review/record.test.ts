import { describe, expect, it } from 'vitest';
import type { ReviewedFinding } from './finding.ts';
import { reviewRecord } from './record.ts';
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
        expect(record).toMatchObject({ repo: 'o/r', number: 7, round: 2, tier: 'high', costUsd: 2.5, finishedAt: '2026-11-07T12:00:00.000Z' });
    });
});

describe('inlineBody', () => {
    it('asks for a reaction', () => {
        expect(inlineBody(onDiff)).toContain('React 👍 if this is a real problem or 👎 if it is wrong.');
    });
});
