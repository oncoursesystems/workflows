import { describe, expect, it } from 'vitest';
import { FakeGitHub } from './fake-github.ts';
import { onMerged, type ClosedPr } from './merged.ts';
import { fakeSentry } from './testing.ts';

const repo = { owner: 'o', repo: 'r' };

const issue = { id: '101', shortId: 'ONCOURSE-WEB-3K', title: 't', culprit: '', permalink: 'p', project: { slug: 'oncourse-web' }, count: '1', substatus: 'ongoing', level: 'error' };

const setup = (notes: string[] = []) => {
    const github = new FakeGitHub();
    github.pr({ number: 7, state: 'closed', merged: true, labels: ['sentry-autofix'] });
    const { options: sentry, calls } = fakeSentry(({ method, url }) => {
        if (method !== 'GET') return {};
        return url.pathname.endsWith('/comments/') ? notes.map((text) => ({ type: 'note', data: { text } })) : issue;
    });
    return { github, sentry, calls };
};

const merged: ClosedPr = {
    number: 7,
    merged: true,
    labels: ['sentry-autofix'],
    body: 'x\n<!-- sentry-issue: 101 -->',
    url: 'https://github.com/o/r/pull/7',
    headRef: 'sentry-fix/oncourse-web-3k',
};

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

    it('skips a pull request whose marker names an issue its branch is not for', async () => {
        const { github, sentry, calls } = setup();
        expect(await onMerged({ ...merged, headRef: 'sentry-fix/oncourse-web-9z' }, github.octokit, repo, sentry)).toEqual({
            kind: 'mismatch',
            reason: 'its marker names Sentry issue ONCOURSE-WEB-3K, but its branch is sentry-fix/oncourse-web-9z',
        });
        expect(github.calls).toEqual([]);
        expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
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
