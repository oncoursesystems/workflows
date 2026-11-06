import { describe, expect, it } from 'vitest';
import type { Classification } from './classify.ts';
import { checkTitle, renderSummary } from './report.ts';

const classification: Classification = {
    tier: 'medium',
    reasons: [
        { source: 'size', tier: 'medium', text: '512 changed lines outside ignored paths, above the low-risk limit of 400.' },
        { source: 'fallback', tier: 'medium', text: 'Jev failed: a | b\nc' },
    ],
    jev: {
        status: 'answered',
        verdict: {
            model: 'jev-1.14.0',
            tier: 'low',
            tierProbabilities: { low: 0.6, medium: 0.3, high: 0.1 },
            accessChange: 0.42,
            sensitiveArea: 0.66,
            inputTokens: 21345,
            diff: 'truncated',
        },
    },
    countedLines: 512,
    truncatedDiff: true,
};

describe('renderSummary', () => {
    const summary = renderSummary(classification);

    it('shows the tier, reasons, probabilities, model, tokens, truncation, and the feedback line', () => {
        expect(summary).toContain('## Medium risk');
        expect(summary).toContain('| size | medium | 512 changed lines');
        expect(summary).toContain('| medium | 30.0% |');
        expect(summary).toContain('Access change: 42.0%.');
        expect(summary).toContain('Sensitive area: 66.0%.');
        expect(summary).toContain('`jev-1.14.0`, 21,345 input tokens');
        expect(summary).toContain('truncated');
        expect(summary).toContain('Add the `risk-ok` label');
    });

    it('escapes table-breaking characters in reason text', () => {
        expect(summary).toContain('| fallback | medium | Jev failed: a \\| b c |');
    });
});

describe('checkTitle', () => {
    it('names the tier', () => {
        expect(checkTitle('high')).toBe('High risk');
    });
});
