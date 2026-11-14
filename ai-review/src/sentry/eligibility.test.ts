import { describe, expect, it } from 'vitest';
import { decide, type AutoFixPr, type IssueHistory } from './eligibility.ts';
import { sentryIssue } from './testing.ts';

const pr = (number: number, state: AutoFixPr['state'], labels: string[] = ['sentry-autofix']): AutoFixPr => ({
    number,
    sentryIssueId: '101',
    state,
    labels,
});

const history = (fields: Partial<IssueHistory> = {}): IssueHistory => ({ autoPrs: [], mentioningOpenPrs: [], notes: [], ...fields });

const ongoing = sentryIssue({ substatus: 'ongoing' });
const regressed = sentryIssue({ substatus: 'regressed' });
const escalating = sentryIssue({ substatus: 'escalating' });

describe('decide', () => {
    it('attempts an issue with no history', () => {
        expect(decide(ongoing, history())).toEqual({ kind: 'attempt' });
    });

    it('skips an issue with an open auto pull request, even when it regressed', () => {
        expect(decide(regressed, history({ autoPrs: [pr(5, 'open')] }))).toEqual({ kind: 'skip', reason: 'open-pr', detail: 'open pull request #5' });
    });

    it('skips an issue that an open pull request by a person mentions', () => {
        expect(decide(ongoing, history({ mentioningOpenPrs: [9, 9] }))).toMatchObject({ reason: 'open-pr', detail: 'open pull request #9' });
    });

    it('skips an issue whose fix merged and waits for a release, even when it is escalating', () => {
        const merged = history({ autoPrs: [pr(5, 'merged', ['sentry-autofix', 'sentry-fix-merged'])] });
        expect(decide(escalating, merged)).toMatchObject({ reason: 'fix-pending-release', detail: '#5 merged and waits for a release' });
    });

    it('treats a merged pull request the merge hook missed as waiting for a release', () => {
        expect(decide(ongoing, history({ autoPrs: [pr(5, 'merged')] }))).toMatchObject({ reason: 'fix-pending-release' });
    });

    it('skips an issue whose fix shipped, until it regresses or escalates', () => {
        const released = history({ autoPrs: [pr(5, 'merged', ['sentry-autofix', 'Sentry-Fix-Released'])] });
        expect(decide(ongoing, released)).toMatchObject({ reason: 'released-fix' });
        expect(decide(regressed, released)).toEqual({ kind: 'attempt' });
        expect(decide(escalating, released)).toEqual({ kind: 'attempt' });
    });

    it('skips an issue whose auto pull request was closed unmerged, until it regresses or escalates', () => {
        const rejected = history({ autoPrs: [pr(5, 'closed'), pr(8, 'closed')] });
        expect(decide(ongoing, rejected)).toEqual({ kind: 'skip', reason: 'rejected-pr', detail: '#5, #8 closed without merging' });
        expect(decide(sentryIssue({ substatus: null }), rejected)).toMatchObject({ reason: 'rejected-pr' });
        expect(decide(regressed, rejected)).toEqual({ kind: 'attempt' });
    });

    it('skips an issue that already got a no-fix note, until it regresses or escalates', () => {
        const noted = history({ notes: [{ kind: 'no-fix', date: '2026-11-06' }, { kind: 'pr', url: 'https://x' }] });
        expect(decide(ongoing, noted)).toEqual({ kind: 'skip', reason: 'prior-no-fix', detail: 'no confident fix on 2026-11-06' });
        expect(decide(escalating, noted)).toEqual({ kind: 'attempt' });
    });

    it('reports the first rule that applies', () => {
        const everything = history({
            autoPrs: [pr(5, 'closed'), pr(6, 'merged', ['sentry-fix-released'])],
            notes: [{ kind: 'no-fix', date: '2026-11-06' }],
        });
        expect(decide(ongoing, everything)).toMatchObject({ reason: 'released-fix' });
    });
});
