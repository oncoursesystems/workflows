import { describe, expect, it } from 'vitest';
import { parsePullRequestNumber } from './github.ts';

describe('parsePullRequestNumber', () => {
    it('reads a positive whole number', () => {
        expect(parsePullRequestNumber('2663')).toBe(2663);
        expect(parsePullRequestNumber(' 806 ')).toBe(806);
    });

    it('rejects anything that is not a pull request number', () => {
        for (const text of ['', '0', '-3', '12abc', '1.5', '1e3', '#806']) {
            expect(() => parsePullRequestNumber(text)).toThrow(`expected a pull request number, got "${text}"`);
        }
    });
});
