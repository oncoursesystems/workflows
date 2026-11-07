import { describe, expect, it } from 'vitest';
import type { ReviewedFinding } from './finding.ts';
import { inlineBody, MINOR_HEADINGS, minorHeading, renderFailed, renderRunning, renderSummary } from './report.ts';
import type { ReviewResult } from './review.ts';
import { readState } from './state.ts';

const finding = (placement: ReviewedFinding['placement'], line: number): ReviewedFinding => ({
    kind: 'correctness',
    file: 'src/Notes.cs',
    line,
    severity: 'minor',
    claim: `Claim on line ${line}.`,
    failureScenario: `Failure on line ${line}.`,
    verdicts: [
        { real: true, introducedByPullRequest: true, severity: 'minor', reason: 'r' },
        { real: true, introducedByPullRequest: true, severity: 'minor', reason: 'r' },
        { real: false, introducedByPullRequest: true, severity: 'minor', reason: 'r' },
    ],
    placement,
});

const result: ReviewResult = {
    tier: 'medium',
    findings: [finding('minor', 10), finding('pre-existing', 20), finding('dropped', 30)],
    candidates: 3,
    agents: [],
    costUsd: 1.5,
    durationMs: 65_000,
};

const state = { reviewedSha: 'abcdef1234567890', round: 2 };

describe('renderSummary', () => {
    const summary = renderSummary({ repo: 'o/r', result, state, inline: [], outsideDiff: [], scope: 'the whole pull request' });

    it('gives each finding its own block with a link to the reviewed line', () => {
        expect(summary).toContain(`### ${minorHeading(state.reviewedSha)}\n\n**[`);
        expect(summary).toContain('**[`src/Notes.cs:10`](https://github.com/o/r/blob/abcdef1234567890/src/Notes.cs#L10)** (correctness)\n\nClaim on line 10.\n\n**Failure scenario:** Failure on line 10.\n\n<sub>2 of 3 reviewers confirmed.</sub>');
        expect(summary).toContain('### Pre-existing');
        expect(summary).not.toContain('Claim on line 30.');
    });

    it('says neither trial nor nit', () => {
        expect(summary.toLowerCase()).not.toMatch(/trial|nit\b/);
        expect(inlineBody(finding('inline', 10)).toLowerCase()).not.toMatch(/trial|nit\b/);
    });

    it('keeps the state so the next run can continue from it', () => {
        expect(readState(summary)).toEqual(state);
    });
});

describe('minorHeading', () => {
    it('picks a heading from the list, the same one for the same commit', () => {
        expect(MINOR_HEADINGS).toContain(minorHeading('abc'));
        expect(minorHeading('abc')).toBe(minorHeading('abc'));
    });

    it('varies the heading across commits', () => {
        const picked = new Set(Array.from({ length: 200 }, (_, i) => minorHeading(`sha-${i}`)));
        expect(picked.size).toBe(MINOR_HEADINGS.length);
    });
});

describe('renderRunning', () => {
    it('keeps the previous state, so a run that fails midway does not reset the round', () => {
        const previous = { reviewedSha: 'old', round: 1 };
        expect(readState(renderRunning(state, 'the changes since `old`', previous))).toEqual(previous);
        expect(readState(renderRunning(state, 'the whole pull request', undefined))).toBeUndefined();
    });
});

describe('renderFailed', () => {
    it('says why and keeps the previous state, so a push retries from the last finished round', () => {
        const previous = { reviewedSha: 'old', round: 1 };
        const failed = renderFailed(state, 'claude-opus-5-5 stopped with error_max_turns', previous);
        expect(failed).toContain('`abcdef1` did not finish: claude-opus-5-5 stopped with error_max_turns');
        expect(readState(failed)).toEqual(previous);
    });
});
