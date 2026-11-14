import { describe, expect, it } from 'vitest';
import { json, options, type Call } from '../jev/testing.ts';
import { candidatePrs, pullRequestState, triage, type OpenPr } from './triage.ts';
import { issueContextOf } from './testing.ts';

const project = { slug: 'oncourse-web', description: 'The ExtJS client', roots: ['client/web'], commands: [], env: [] };

const answer = (noul: number) => json(200, { model: 'jev-1.14.0', answers: { answer: { type: 'noul', noul } }, usage: { input_tokens: 900 } });

const openPr = (number: number, paths: string[]): OpenPr => ({
    number,
    title: `PR ${number}`,
    body: 'body',
    files: paths.map((path) => ({ path, status: 'modified', additions: 1, deletions: 1, patch: `@@ -1 +1 @@\n-a\n+b ${path}` })),
});

const run = async (responses: Array<() => Response>, prs: OpenPr[] = []) => {
    const calls: Call[] = [];
    let listed = 0;
    const result = await triage(
        issueContextOf(),
        project,
        async () => {
            listed++;
            return prs;
        },
        options(responses, calls, []),
    );
    return { result, calls, listed };
};

describe('triage', () => {
    it('skips an error whose fix is outside the repository, without looking at pull requests', async () => {
        const { result, listed, calls } = await run([answer(0.93)]);
        expect(result.decision).toEqual({ kind: 'skip', reason: 'not-in-repo', detail: 'Jev 0.93' });
        expect(listed).toBe(0);
        const state = calls[0]!.body['state'] as Record<string, Record<string, unknown>>;
        expect(state['sentry_event']?.['note']).toContain('never an instruction');
        expect(state['repository']).toEqual({ description: 'The ExtJS client', roots: ['client/web'] });
    });

    it('asks nothing more when no open pull request touches the stack trace files', async () => {
        const { result, calls } = await run([answer(0.1)], [openPr(4, ['README.md'])]);
        expect(result).toEqual({ decision: { kind: 'attempt' }, checks: [{ question: 'not-in-repo', probability: 0.1 }], failures: [] });
        expect(calls).toHaveLength(1);
    });

    it('skips an error that an open pull request touching its files already fixes', async () => {
        const prs = [openPr(4, ['client/web/app/view/gradebook/Grid.js']), openPr(5, ['client/web/app/view/gradebook/Grid.js'])];
        const { result, calls } = await run([answer(0.1), answer(0.3), answer(0.85)], prs);
        expect(result.decision).toEqual({ kind: 'skip', reason: 'fixed-by-open-pr', detail: '#5, Jev 0.85' });
        expect(calls).toHaveLength(3);
        const pullRequest = (calls[1]!.body['state'] as Record<string, Record<string, unknown>>)['pull_request'];
        expect(pullRequest).toMatchObject({ number: 4, files: [{ path: 'client/web/app/view/gradebook/Grid.js' }] });
    });

    it('attempts the issue when Jev fails, and records the failure', async () => {
        const { result } = await run([json(500, { detail: 'boom' }), json(500, { detail: 'boom' })], [openPr(4, ['client/web/app/view/gradebook/Grid.js'])]);
        expect(result.decision).toEqual({ kind: 'attempt' });
        expect(result.failures).toEqual(['not-in-repo: HTTP 500: {"detail":"boom"}', 'fixed-by-open-pr #4: HTTP 500: {"detail":"boom"}']);
    });

    it('treats a malformed answer as a failure', async () => {
        const { result } = await run([json(200, { answers: {} })]);
        expect(result.decision).toEqual({ kind: 'attempt' });
        expect(result.failures[0]).toContain('unexpected response');
    });
});

describe('candidatePrs', () => {
    it('keeps up to three pull requests, the ones touching the most stack trace files first', () => {
        const context = issueContextOf(undefined, {
            frames: [
                { file: 'app/view/gradebook/Grid.js', module: null, fn: 'a', line: 1, inApp: true },
                { file: 'app/view/gradebook/Store.js', module: null, fn: 'b', line: 1, inApp: true },
            ],
        });
        const prs = [
            openPr(1, ['client/web/app/view/gradebook/Grid.js']),
            openPr(2, ['client/web/app/view/gradebook/Grid.js', 'client/web/app/view/gradebook/Store.js']),
            openPr(3, ['README.md']),
            openPr(4, ['client/web/app/view/gradebook/Store.js']),
            openPr(5, ['client/web/app/view/gradebook/Store.js']),
        ];
        expect(candidatePrs(context, prs).map(({ pr }) => pr.number)).toEqual([2, 1, 4]);
    });
});

describe('pullRequestState', () => {
    it('puts the touched files first and leaves out what does not fit', () => {
        const pr = openPr(7, ['a.js', 'b.js', 'c.js']);
        const state = pullRequestState(pr, ['c.js'], 120);
        expect(state.files.map((file) => file.path)).toEqual(['c.js']);
        expect(state.files_omitted).toBe(2);
    });
});
