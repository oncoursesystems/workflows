import { describe, expect, it } from 'vitest';
import { hasNote, issueMarker, markedIssueId, mentionsShortId, parseNoteMark, renderNoteMark } from './markers.ts';

describe('the pull request marker', () => {
    it('round-trips an issue id through a body', () => {
        expect(markedIssueId(`## Fix\n\nbody\n\n${issueMarker('4412')}\n`)).toBe('4412');
    });

    it('finds nothing in a body without one', () => {
        expect(markedIssueId('Fixes ONCOURSE-WEB-3K')).toBeUndefined();
        expect(markedIssueId(null)).toBeUndefined();
        expect(markedIssueId('<!-- sentry-issue: abc -->')).toBeUndefined();
    });
});

describe('mentionsShortId', () => {
    it('matches the short ID as a whole word, in any case', () => {
        expect(mentionsShortId('Fixes oncourse-web-3k in the grid', 'ONCOURSE-WEB-3K')).toBe(true);
        expect(mentionsShortId('[ONCOURSE-WEB-3K] guard', 'ONCOURSE-WEB-3K')).toBe(true);
    });

    it('does not match a longer short ID or one with another prefix', () => {
        expect(mentionsShortId('ONCOURSE-WEB-3K7', 'ONCOURSE-WEB-3K')).toBe(false);
        expect(mentionsShortId('X-ONCOURSE-WEB-3K', 'ONCOURSE-WEB-3K')).toBe(false);
    });
});

describe('the Sentry note marks', () => {
    it.each([
        { kind: 'pr', url: 'https://github.com/o/r/pull/12' },
        { kind: 'no-fix', date: '2026-11-13' },
        { kind: 'merged', url: 'https://github.com/o/r/pull/12' },
    ] as const)('round-trips $kind through the first line of a note', (mark) => {
        expect(parseNoteMark(`${renderNoteMark(mark)}\n\nThe analysis.`)).toEqual(mark);
    });

    it('ignores a note a person wrote', () => {
        expect(parseNoteMark('Looked at this, it is the network')).toBeUndefined();
        expect(parseNoteMark('see [sentry-fix] pr https://x')).toBeUndefined();
    });

    it('knows a note it already posted', () => {
        const notes = ['[sentry-fix] pr https://github.com/o/r/pull/12\nOpened a fix.', 'hello'];
        expect(hasNote(notes, { kind: 'pr', url: 'https://github.com/o/r/pull/12' })).toBe(true);
        expect(hasNote(notes, { kind: 'pr', url: 'https://github.com/o/r/pull/13' })).toBe(false);
        expect(hasNote(notes, { kind: 'merged', url: 'https://github.com/o/r/pull/12' })).toBe(false);
    });
});
