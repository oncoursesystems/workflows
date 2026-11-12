import { describe, expect, it } from 'vitest';
import { diffOfWholeFilesThatFit, stateBudgetChars } from './state.ts';
import { file } from './testing.ts';

describe('diffOfWholeFilesThatFit', () => {
    it('keeps every file when the diff fits', () => {
        const diff = diffOfWholeFilesThatFit([file('a.js', '+a'), file('b.js', '+b')], 1000);
        expect(diff.coverage).toBe('complete');
        expect(diff.text).toContain('+a');
        expect(diff.text).toContain('+b');
        expect(diff.text).not.toContain('[diff truncated');
    });

    it('marks a truncated diff with how many files it shows and stays within budget', () => {
        const files = [file('a.js', 'x'.repeat(300)), file('big.js', 'y'.repeat(5000)), file('c.js', 'z'.repeat(300))];
        const diff = diffOfWholeFilesThatFit(files, 1000);
        expect(diff.coverage).toBe('truncated');
        expect(diff.text.endsWith('[diff truncated: 2 of 3 files shown]')).toBe(true);
        expect(diff.text).not.toContain('yyyy');
        expect(diff.text).toContain('zzzz');
        expect(diff.text.length - '[diff truncated: 2 of 3 files shown]'.length).toBeLessThanOrEqual(1000);
    });

    it('names files that have no patch', () => {
        const diff = diffOfWholeFilesThatFit([{ path: 'logo.png', status: 'added', additions: 0, deletions: 0 }], 1000);
        expect(diff.text).toContain('logo.png');
        expect(diff.text).toContain('no patch');
    });
});

describe('stateBudgetChars', () => {
    it('shrinks by the size of the largest question, not the number of questions', () => {
        const question = { type: 'noul', instructions: 'y'.repeat(5000) };
        const small = { a: { type: 'noul', instructions: 'x' } };
        expect(stateBudgetChars(small) - stateBudgetChars({ ...small, b: question })).toBeGreaterThan(4900);
        expect(stateBudgetChars({ b: question, c: question })).toBe(stateBudgetChars({ b: question }));
    });

    it('never goes below zero', () => {
        expect(stateBudgetChars({ a: 'x'.repeat(500_000) })).toBe(0);
    });
});
