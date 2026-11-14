import { describe, expect, it } from 'vitest';
import { ensureRelease, fetchIssue, listNotes, postNote, projectId, rankIssues, resolveInRelease } from './sentry.ts';
import { fakeSentry } from './testing.ts';

const issueBody = (id: string, count: string, fields: Record<string, unknown> = {}) => ({
    id,
    shortId: `WEB-${id}`,
    title: `Error ${id}`,
    culprit: null,
    permalink: `https://sentry.io/issues/${id}/`,
    project: { slug: 'oncourse-web', id: '9' },
    count,
    substatus: 'ongoing',
    level: 'error',
    userCount: 4,
    ...fields,
});

describe('rankIssues', () => {
    it('asks for unresolved issues in the environment across every project, by frequency in the period', async () => {
        const { options, calls } = fakeSentry(() => [issueBody('1', '5'), issueBody('2', '80'), issueBody('3', '80')]);
        const issues = await rankIssues(options, { projectIds: ['11', '12'], environment: 'production', period: '7d' });
        const url = calls[0]!.url;
        expect(url.pathname).toBe('/api/0/organizations/o/issues/');
        expect(url.searchParams.getAll('project')).toEqual(['11', '12']);
        expect(url.searchParams.get('environment')).toBe('production');
        expect(url.searchParams.get('query')).toBe('is:unresolved environment:"production"');
        expect(url.searchParams.get('statsPeriod')).toBe('7d');
        expect(url.searchParams.get('sort')).toBe('freq');
        expect(url.searchParams.get('limit')).toBe('50');
        expect(issues.map((issue) => [issue.id, issue.count])).toEqual([['2', 80], ['3', 80], ['1', 5]]);
        expect(issues[0]).toEqual({
            id: '2',
            shortId: 'WEB-2',
            title: 'Error 2',
            culprit: '',
            permalink: 'https://sentry.io/issues/2/',
            project: 'oncourse-web',
            count: 80,
            substatus: 'ongoing',
            level: 'error',
        });
    });

    it('fails with the status and the text when Sentry refuses', async () => {
        const { options } = fakeSentry(() => new Response('{"detail":"Invalid token"}', { status: 401 }));
        await expect(rankIssues(options, { projectIds: ['1'], environment: 'production', period: '7d' })).rejects.toThrow(
            'failed with 401: {"detail":"Invalid token"}',
        );
    });

    it('fails on a response that is not an issue list', async () => {
        const { options } = fakeSentry(() => [{ id: 1 }]);
        await expect(rankIssues(options, { projectIds: ['1'], environment: 'production', period: '7d' })).rejects.toThrow(
            'unexpected issue list',
        );
    });
});

describe('the issue endpoints', () => {
    it('resolves a project slug to its id', async () => {
        const { options, calls } = fakeSentry(() => ({ id: '4507', slug: 'oncourse-web' }));
        await expect(projectId(options, 'oncourse-web')).resolves.toBe('4507');
        expect(calls[0]!.url.pathname).toBe('/api/0/projects/o/oncourse-web/');
    });

    it('reads one issue', async () => {
        const { options, calls } = fakeSentry(() => issueBody('7', '3', { substatus: 'regressed' }));
        await expect(fetchIssue(options, '7')).resolves.toMatchObject({ id: '7', count: 3, substatus: 'regressed' });
        expect(calls[0]!.url.pathname).toBe('/api/0/organizations/o/issues/7/');
    });

    it('lists the text of notes only', async () => {
        const { options } = fakeSentry(() => [
            { type: 'note', data: { text: '[sentry-fix] no-fix 2026-11-06' } },
            { type: 'set_resolved', data: {} },
        ]);
        await expect(listNotes(options, '7')).resolves.toEqual(['[sentry-fix] no-fix 2026-11-06']);
    });

    it('posts a note, creates the release and resolves in it', async () => {
        const { options, calls } = fakeSentry(() => ({}));
        await postNote(options, '7', 'hello');
        await ensureRelease(options, 'OnCourse.Web@2026.11.13.1200', ['oncourse-dotnet', 'oncourse-web']);
        await resolveInRelease(options, '7', 'OnCourse.Web@2026.11.13.1200');
        expect(calls.map((call) => [call.method, call.url.pathname, call.body])).toEqual([
            ['POST', '/api/0/organizations/o/issues/7/comments/', { text: 'hello' }],
            ['POST', '/api/0/organizations/o/releases/', { version: 'OnCourse.Web@2026.11.13.1200', projects: ['oncourse-dotnet', 'oncourse-web'] }],
            ['PUT', '/api/0/organizations/o/issues/7/', { status: 'resolved', statusDetails: { inRelease: 'OnCourse.Web@2026.11.13.1200' } }],
        ]);
    });
});
