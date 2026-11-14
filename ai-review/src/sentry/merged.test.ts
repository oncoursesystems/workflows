import { describe, expect, it } from 'vitest';
import { FakeGitHub } from './fake-github.ts';
import { onMerged, type ClosedPr } from './merged.ts';
import { fakeSentry } from './testing.ts';

const repo = { owner: 'o', repo: 'r' };

const setup = (notes: string[] = []) => {
    const github = new FakeGitHub();
    github.pr({ number: 7, state: 'closed', merged: true, labels: ['sentry-autofix'] });
    const { options: sentry, calls } = fakeSentry(({ method }) => (method === 'GET' ? notes.map((text) => ({ type: 'note', data: { text } })) : {}));
    return { github, sentry, calls };
};

const merged: ClosedPr = { number: 7, merged: true, labels: ['sentry-autofix'], body: 'x\n<!-- sentry-issue: 101 -->', url: 'https://github.com/o/r/pull/7' };

describe('onMerged', () => {
    it('labels a merged auto-fix pull request and notes the merge on Sentry', async () => {
        const { github, sentry, calls } = setup();
        expect(await onMerged(merged, github.octokit, repo, sentry)).toEqual({ kind: 'marked', issueId: '101' });
        expect(github.prs[0]?.labels).toEqual(['sentry-autofix', 'sentry-fix-merged']);
        expect(calls.filter((call) => call.method === 'POST').map((call) => [call.url.pathname, call.body])).toEqual([
            [
                '/api/0/organizations/o/issues/101/comments/',
                { text: '[sentry-fix] merged https://github.com/o/r/pull/7\n\nThe fix merged. The issue resolves in the release that ships it.' },
            ],
        ]);
    });

    it('does nothing twice on a rerun', async () => {
        const { github, sentry, calls } = setup(['[sentry-fix] merged https://github.com/o/r/pull/7\n\nThe fix merged.']);
        await onMerged({ ...merged, labels: ['sentry-autofix', 'sentry-fix-merged'] }, github.octokit, repo, sentry);
        expect(github.calls.filter((call) => call.startsWith('addLabels'))).toEqual([]);
        expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    });

    it.each([
        ['a pull request closed without merging', { merged: false }, 'it closed without merging'],
        ['a pull request without the label', { labels: ['bug'] }, 'it has no sentry-autofix label'],
        ['a pull request without the marker', { body: 'Fixes ONCOURSE-WEB-3K' }, 'its body has no sentry-issue marker'],
    ])('ignores %s', async (_name, fields, reason) => {
        const { github, sentry, calls } = setup();
        expect(await onMerged({ ...merged, ...fields }, github.octokit, repo, sentry)).toEqual({ kind: 'ignored', reason });
        expect(github.calls).toEqual([]);
        expect(calls).toEqual([]);
    });
});
