import { describe, expect, it } from 'vitest';
import { parsePullRequestNumber, parsePullRequestRef, parseRepo } from './client.ts';

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

describe('parseRepo', () => {
    it('splits owner and repo', () => {
        expect(parseRepo('oncoursesystems/workflows')).toEqual({ owner: 'oncoursesystems', repo: 'workflows' });
    });

    it('rejects anything else', () => {
        for (const text of ['workflows', 'a/b/c', '/b', 'a/']) expect(() => parseRepo(text)).toThrow('expected owner/repo');
    });
});

describe('parsePullRequestRef', () => {
    const expected = { repo: { owner: 'o', repo: 'r' }, number: 12 };

    it('reads owner/repo#number and a pull request URL', () => {
        expect(parsePullRequestRef('o/r#12')).toEqual(expected);
        expect(parsePullRequestRef('https://github.com/o/r/pull/12')).toEqual(expected);
        expect(parsePullRequestRef('https://github.com/o/r/pull/12/files#diff')).toEqual(expected);
    });

    it('rejects a reference without a number', () => {
        for (const text of ['o/r', 'o/r#', 'o/r#x', 'o#12', 'o/r#1#2']) {
            expect(() => parsePullRequestRef(text)).toThrow();
        }
    });
});
