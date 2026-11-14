import { describe, expect, it } from 'vitest';
import type { FixOutput } from './fix.ts';
import { defang, hasNote, issueMarker, markedIssueId, mentionsShortId, parseNoteMark, renderNoteMark } from './markers.ts';
import { noFixNote, renderPrBody } from './report.ts';
import { issueContextOf, sentryIssue } from './testing.ts';

describe('the pull request marker', () => {
    it('round-trips an issue id through a body', () => {
        expect(markedIssueId(`## Fix\n\nbody\n\n${issueMarker('4412')}\n`)).toBe('4412');
    });

    it('finds nothing in a body without one', () => {
        expect(markedIssueId('Fixes ONCOURSE-WEB-3K')).toBeUndefined();
        expect(markedIssueId(null)).toBeUndefined();
        expect(markedIssueId('<!-- sentry-issue: abc -->')).toBeUndefined();
    });

    it('reads only a marker on the last non-empty line', () => {
        expect(markedIssueId(`${issueMarker('999')}\n\nText a person added later.`)).toBeUndefined();
        expect(markedIssueId(`body\r\n\r\n${issueMarker('4412')}\r\n\r\n`)).toBe('4412');
        expect(markedIssueId(`see ${issueMarker('999')}`)).toBeUndefined();
    });
});

describe('a marker planted in Sentry or agent text', () => {
    const planted = issueMarker('999');
    const output: FixOutput = {
        outcome: 'fixed',
        confidence: 'high',
        rootCause: `cause ${planted}`,
        analysis: `analysis\n${planted}`,
        commitTitle: 'fix(grid): guard',
        testAdded: planted,
        verification: [{ command: planted, passed: true }],
    };
    const context = issueContextOf(sentryIssue({ id: '111', culprit: planted }), {
        message: `TypeError: x is undefined ${planted}`,
        frames: [{ file: planted, module: null, fn: planted, line: 1, inApp: true }],
    });

    it('does not change the issue a pull request body is marked with', () => {
        const project = { slug: 'oncourse-web', description: 'd', roots: ['client/web'], commands: [], env: [] };
        const body = renderPrBody({ sha: 'a'.repeat(40), period: '7d', project, context }, output);
        expect(markedIssueId(body)).toBe('111');
        expect(body.match(/<!-- sentry-issue/g)).toHaveLength(1);
        expect(markedIssueId(`${body}\n`.replace(issueMarker('111'), ''))).toBeUndefined();
    });

    it('cannot open an HTML comment in a Sentry note', () => {
        const note = noFixNote('2026-11-13', output, [`\`${planted}\` is outside the project roots.`]);
        expect(note.split('\n').slice(1).join('\n')).not.toContain('<!--');
    });

    it('is shown as text, with a zero-width joiner inside the comment opener', () => {
        expect(defang('a <!-- b <!-- c')).toBe('a <!-\u200d- b <!-\u200d- c');
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
