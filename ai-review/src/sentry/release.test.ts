import { describe, expect, it } from 'vitest';
import type { SentryFixConfig } from './config.ts';
import { FakeGitHub } from './fake-github.ts';
import { commitsBetween, fixesInRange, releaseName, resolveRelease } from './release.ts';
import { fakeSentry } from './testing.ts';

const project = (slug: string) => ({ slug, description: slug, roots: ['src'], commands: [], env: [] });

const config: SentryFixConfig = {
    limit: 5,
    environment: 'production',
    period: '7d',
    projects: [project('oncourse-dotnet'), project('oncourse-web'), project('oncourse-mobile')],
    apps: [
        { name: 'web', release: 'OnCourse.Web@{version}', projects: ['oncourse-dotnet', 'oncourse-web'] },
        { name: 'mobile', release: 'com.oncourse.mobile@{version}', projects: ['oncourse-mobile'] },
    ],
};

const repo = { owner: 'o', repo: 'r' };

describe('releaseName', () => {
    it('renders the app template with the version', () => {
        expect(releaseName(config, { app: 'web', version: '2026.11.13.1200', release: '' })).toBe('OnCourse.Web@2026.11.13.1200');
    });

    it('takes a full release name as given, for a mobile store build', () => {
        expect(releaseName(config, { app: 'mobile', version: '', release: 'com.oncourse.mobile@4.2.0+118' })).toBe('com.oncourse.mobile@4.2.0+118');
    });

    it('fails for an unknown app, or without a version or a name', () => {
        expect(() => releaseName(config, { app: 'desktop', version: '1', release: '' })).toThrow('no app named desktop');
        expect(() => releaseName(config, { app: 'web', version: '', release: '' })).toThrow('give the version or the full release name');
    });
});

describe('fixesInRange', () => {
    it('keeps the fixes whose merge commit is in the release range', () => {
        const fixes = [
            { number: 1, mergeCommitSha: 'c1', issueId: '11', headRef: 'h' },
            { number: 2, mergeCommitSha: 'c9', issueId: '12', headRef: 'h' },
            { number: 3, mergeCommitSha: null, issueId: '13', headRef: 'h' },
        ];
        expect(fixesInRange(fixes, new Set(['c1', 'c2']))).toEqual([fixes[0]]);
    });
});

describe('commitsBetween', () => {
    it('reads every page of the comparison', async () => {
        const github = new FakeGitHub();
        github.compareCommits = Array.from({ length: 230 }, (_, i) => `c${i}`);
        const shas = await commitsBetween(github.octokit, repo, 'v1', 'v2');
        expect(shas.size).toBe(230);
        expect(shas.has('c229')).toBe(true);
    });
});

describe('resolveRelease', () => {
    const setup = () => {
        const github = new FakeGitHub();
        github.compareCommits = ['m1', 'm2', 'm3', 'other'];
        const merged = (number: number, sha: string, issueId: string, head = `sentry-fix/s-${issueId}`) =>
            github.pr({
                number,
                state: 'closed',
                merged: true,
                mergeCommitSha: sha,
                labels: ['sentry-autofix', 'sentry-fix-merged'],
                body: `<!-- sentry-issue: ${issueId} -->`,
                head,
            });
        merged(1, 'm1', '11');
        merged(2, 'm2', '12');
        merged(3, 'later', '13');
        merged(4, 'm3', '14');
        const projects: Record<string, string> = { '11': 'oncourse-web', '12': 'oncourse-mobile', '13': 'oncourse-web', '14': 'oncourse-dotnet' };
        const { options: sentry, calls } = fakeSentry(({ method, url }) => {
            const id = url.pathname.split('/').at(-2)!;
            if (method === 'PUT') return {};
            return { id, shortId: `S-${id}`, title: 't', culprit: '', permalink: 'p', project: { slug: projects[id] }, count: '1', substatus: 'ongoing', level: 'error' };
        });
        return { github, sentry, calls, merged };
    };

    it('resolves the shipped fixes of the app in the exact release, and swaps their label', async () => {
        const { github, sentry, calls } = setup();
        const result = await resolveRelease({
            octokit: github.octokit,
            repo,
            sentry,
            config,
            input: { app: 'web', version: '2026.11.13.1200', release: '', tag: '2026.11.13.1200', previousTag: '2026.11.06.1200' },
        });
        expect(result.release).toBe('OnCourse.Web@2026.11.13.1200');
        expect(result.outcomes.map(({ number, resolved, reason }) => [number, resolved, reason])).toEqual([
            [1, true, 'resolved in OnCourse.Web@2026.11.13.1200'],
            [2, false, 'oncourse-mobile does not report web'],
            [4, true, 'resolved in OnCourse.Web@2026.11.13.1200'],
        ]);
        expect(calls.filter((call) => call.method === 'PUT').map((call) => [call.url.pathname, call.body])).toEqual([
            ['/api/0/organizations/o/issues/11/', { status: 'resolved', statusDetails: { inRelease: 'OnCourse.Web@2026.11.13.1200' } }],
            ['/api/0/organizations/o/issues/14/', { status: 'resolved', statusDetails: { inRelease: 'OnCourse.Web@2026.11.13.1200' } }],
        ]);
        const labels = (number: number) => github.prs.find((pr) => pr.number === number)?.labels;
        expect(labels(1)).toEqual(['sentry-autofix', 'sentry-fix-released']);
        expect(labels(2)).toEqual(['sentry-autofix', 'sentry-fix-merged']);
        expect(labels(3)).toEqual(['sentry-autofix', 'sentry-fix-merged']);
    });

    it('skips, with a warning, a pull request whose marker names an issue its branch is not for', async () => {
        const { github, sentry, calls, merged } = setup();
        github.compareCommits.push('m5');
        merged(5, 'm5', '11', 'sentry-fix/s-77');
        const input = { app: 'web', version: '1', release: '', tag: 't', previousTag: 'p' };
        const { outcomes } = await resolveRelease({ octokit: github.octokit, repo, sentry, config, input });
        expect(outcomes.find((outcome) => outcome.number === 5)).toEqual({
            number: 5,
            issueId: '11',
            shortId: 'S-11',
            resolved: false,
            warning: true,
            reason: 'skipped, because its marker names S-11 but its branch is sentry-fix/s-77',
        });
        expect(github.prs.find((pr) => pr.number === 5)?.labels).toEqual(['sentry-autofix', 'sentry-fix-merged']);
        expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
    });

    it('finds nothing left to do when run again', async () => {
        const { github, sentry, calls } = setup();
        const input = { app: 'web', version: '1', release: '', tag: 't', previousTag: 'p' };
        await resolveRelease({ octokit: github.octokit, repo, sentry, config, input });
        const before = calls.length;
        const again = await resolveRelease({ octokit: github.octokit, repo, sentry, config, input });
        expect(again.outcomes.filter((outcome) => outcome.resolved)).toEqual([]);
        expect(calls.slice(before).filter((call) => call.method === 'PUT')).toEqual([]);
    });
});
