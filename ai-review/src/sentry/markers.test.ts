import { describe, expect, it } from 'vitest';
import type { FixOutput } from './fix.ts';
import { commitMarker, defang, hasNote, issueMarker, markedCommit, markedIssueId, mentionsShortId, parseNoteMark, renderNoteMark } from './markers.ts';
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

describe('markedCommit', () => {
    const sha = 'b'.repeat(40);

    it('reads the commit on the line directly above the issue marker', () => {
        expect(markedCommit(`body\n\n${commitMarker(sha)}\n${issueMarker('4412')}\n`)).toBe(sha);
        expect(markedCommit(`body\r\n\r\n${commitMarker(sha)}\r\n${issueMarker('4412')}\r\n`)).toBe(sha);
    });

    it('reads nothing when the issue marker is not last, or the commit is not right above it', () => {
        expect(markedCommit(`body\n\n${issueMarker('4412')}\n`)).toBeUndefined();
        expect(markedCommit(`${commitMarker(sha)}\n${issueMarker('4412')}\n\nText a person added later.`)).toBeUndefined();
        expect(markedCommit(`${commitMarker(sha)}\nmore\n${issueMarker('4412')}`)).toBeUndefined();
        expect(markedCommit(`${commitMarker('abc')}\n${issueMarker('4412')}`)).toBeUndefined();
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
        const body = renderPrBody({ sha: 'a'.repeat(40), period: '7d', project, context }, output, [{ command: planted, exitCode: 0, tail: planted }], 'c'.repeat(40));
        expect(markedIssueId(body)).toBe('111');
        expect(markedCommit(body)).toBe('c'.repeat(40));
        expect(body.match(/<!-- sentry-issue/g)).toHaveLength(1);
        expect(markedIssueId(`${body}\n`.replace(issueMarker('111'), ''))).toBeUndefined();
    });

    it('cannot record a commit in a pull request body', () => {
        const forged = commitMarker('d'.repeat(40));
        const project = { slug: 'oncourse-web', description: 'd', roots: ['client/web'], commands: [], env: [] };
        const forgedContext = { ...context, message: forged };
        const body = renderPrBody({ sha: 'a'.repeat(40), period: '7d', project, context: forgedContext }, { ...output, analysis: forged }, [], undefined);
        expect(markedCommit(body)).toBeUndefined();
        expect(body.match(/<!-- sentry-fix-commit/g)).toBeNull();
    });

    it('cannot open an HTML comment in a Sentry note', () => {
        const note = noFixNote({ kind: 'no-fix', date: '2026-11-13', run: '1' }, [`\`${planted}\` is outside the project roots.`], output, [
            { command: 'npm test', exitCode: 1, tail: planted },
        ]);
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
        { kind: 'no-fix', date: '2026-11-13', run: '19283746' },
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

    it('keys a no-fix note by the run that posted it, whatever its date', () => {
        expect(renderNoteMark({ kind: 'no-fix', date: '2026-11-13', run: '42' })).toBe('[sentry-fix] no-fix 2026-11-13 run 42');
        const notes = ['[sentry-fix] no-fix 2026-11-13 run 42\n\nanalysis'];
        expect(hasNote(notes, { kind: 'no-fix', date: '2026-11-15', run: '42' })).toBe(true);
        expect(hasNote(notes, { kind: 'no-fix', date: '2026-11-13', run: '43' })).toBe(false);
    });

    it('still reads a no-fix note from before the run id', () => {
        expect(parseNoteMark('[sentry-fix] no-fix 2026-11-06\n\nanalysis')).toEqual({ kind: 'no-fix', date: '2026-11-06' });
        expect(hasNote(['[sentry-fix] no-fix 2026-11-06'], { kind: 'no-fix', date: '2026-11-06', run: '42' })).toBe(false);
    });
});
