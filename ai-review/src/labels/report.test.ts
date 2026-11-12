import { describe, expect, it } from 'vitest';
import type { LabelRule } from './config.ts';
import { renderSummary } from './report.ts';
import { decideAll } from './reconcile.ts';
import type { LabelRun } from './run.ts';

const rule = (name: string): LabelRule => ({ name, instructions: 'q', addAt: 0.7, removeAt: 0.3 });

const answered = (diff: 'complete' | 'truncated' | 'omitted'): Extract<LabelRun, { status: 'answered' }> => {
    const rules = [rule('ai'), rule('a|b')];
    const decisions = decideAll(['a|b'], rules, new Map([['ai', 0.94], ['a|b', 0.05]]));
    return {
        status: 'answered',
        model: 'jev-1.14.0',
        inputTokens: 12345,
        diff,
        decisions,
        change: { add: ['ai'], remove: ['a|b'] },
        labelsAfter: ['ai'],
    };
};

describe('renderSummary', () => {
    it('shows the model, tokens, diff coverage, and a row per label with its action', () => {
        const text = renderSummary(answered('complete'));
        expect(text).toContain('Model `jev-1.14.0`, 12,345 input tokens. Jev saw the whole diff.');
        expect(text).toContain('| ai | 94.0% | 70.0% | 30.0% | added |');
        expect(text).toContain('| a\\|b | 5.0% | 70.0% | 30.0% | removed |');
    });

    it('says when the diff was cut', () => {
        expect(renderSummary(answered('truncated'))).toContain('truncated');
        expect(renderSummary(answered('omitted'))).toContain('only the file list');
    });
});
