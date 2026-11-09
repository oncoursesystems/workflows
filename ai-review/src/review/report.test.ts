import { describe, expect, it } from 'vitest';
import type { ReviewedFinding } from './finding.ts';
import { inlineBody, MINOR_HEADINGS, minorHeading, renderFailed, renderRunning, renderSummary } from './report.ts';
import type { ReviewResult } from './review.ts';
import { describeScope, startsOver } from './run.ts';
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

describe('summary notes and scope', () => {
    it('shows a note under the tier line and says why a review covers the whole pull request', () => {
        const note = 'The `risk-tier` check had not finished, so this review used the `risk:medium` label as it was.';
        const scope = describeScope({ kind: 'full', reason: 'the risk tier rose from low to high' });
        const summary = renderSummary({ repo: 'o/r', result, state, inline: [], outsideDiff: [], scope, notes: [note] });
        expect(summary).toContain(`for each finding.\n${note}\n`);
        expect(summary).toContain('`abcdef1`, the whole pull request, because the risk tier rose from low to high (round 2 of 3).');
    });
});

describe('startsOver', () => {
    it('starts over only on a run by hand, unless the run asks to continue', () => {
        expect(startsOver('workflow_dispatch', 'true')).toBe(true);
        expect(startsOver('workflow_dispatch', '')).toBe(true);
        expect(startsOver('workflow_dispatch', 'false')).toBe(false);
        expect(startsOver('pull_request', 'true')).toBe(false);
    });
});

describe('API key spend', () => {
    const agent = (billing: 'subscription' | 'api-key', costUsd: number) => ({
        role: 'r',
        model: 'm',
        billing,
        costUsd,
        turns: 1,
        durationMs: 1,
        tools: {},
        denied: [],
    });

    it('shows how much of the review ran on the API key, and nothing when none did', () => {
        const split = renderSummary({
            repo: 'o/r',
            result: { ...result, agents: [agent('subscription', 0.5), agent('api-key', 1.25), agent('api-key', 0.25)] },
            state,
            inline: [],
            outsideDiff: [],
            scope: 'the whole pull request',
        });
        expect(split).toContain('$1.50 ($1.50 on the API key after the subscription hit its limit), 1m 5s.');
        expect(renderSummary({ repo: 'o/r', result, state, inline: [], outsideDiff: [], scope: 's' })).not.toContain('API key');
    });
});
