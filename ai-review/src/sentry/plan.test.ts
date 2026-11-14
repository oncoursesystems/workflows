import { describe, expect, it } from 'vitest';
import { json, options as jevOptions, type Call } from '../jev/testing.ts';
import type { SentryFixConfig } from './config.ts';
import { FakeGitHub } from './fake-github.ts';
import { mentioningOpenPrs, plan, walk } from './plan.ts';
import { renderWalk } from './report.ts';
import { fakeSentry, sentryIssue } from './testing.ts';

const issues = ['1', '2', '3', '4', '5', '6', '7'].map((id) => sentryIssue({ id, shortId: `WEB-${id}`, count: 100 - Number(id) }));

describe('walk', () => {
    it('backfills past skipped issues until it has the limit of attempts, then stops', async () => {
        const judged: string[] = [];
        const result = await walk(issues, 3, async (issue) => {
            judged.push(issue.id);
            return ['2', '3', '5'].includes(issue.id)
                ? { decision: { kind: 'skip', reason: 'open-pr', detail: 'x' } }
                : { decision: { kind: 'attempt' }, planned: issue.id };
        });
        expect(result.planned).toEqual(['1', '4', '6']);
        expect(judged).toEqual(['1', '2', '3', '4', '5', '6']);
        expect(result.rows.map((row) => [row.issue.id, row.decision.kind])).toEqual([
            ['1', 'attempt'],
            ['2', 'skip'],
            ['3', 'skip'],
            ['4', 'attempt'],
            ['5', 'skip'],
            ['6', 'attempt'],
        ]);
    });

    it('attempts fewer than the limit when the ranking runs out', async () => {
        const result = await walk(issues.slice(0, 2), 5, async (issue) => ({ decision: { kind: 'attempt' }, planned: issue.id }));
        expect(result.planned).toEqual(['1', '2']);
    });
});

describe('mentioningOpenPrs', () => {
    it('finds the marker or the short ID in an open pull request', () => {
        const issue = sentryIssue({ id: '77', shortId: 'WEB-3K' });
        const prs = [
            { number: 1, title: 'fix: WEB-3K grid', body: '' },
            { number: 2, title: 'x', body: '<!-- sentry-issue: 77 -->' },
            { number: 3, title: 'WEB-3K7', body: '' },
        ];
        expect(mentioningOpenPrs(issue, prs)).toEqual([1, 2]);
    });
});

const config: SentryFixConfig = {
    limit: 2,
    environment: 'production',
    period: '7d',
    projects: [{ slug: 'oncourse-web', description: 'The ExtJS client', roots: ['client/web'] }],
    apps: [],
};

const issueBody = (id: string, count: number, substatus = 'ongoing', project = 'oncourse-web') => ({
    id,
    shortId: `WEB-${id}`,
    title: `Error ${id}`,
    culprit: 'Grid.js',
    permalink: `https://sentry.io/issues/${id}/`,
    project: { slug: project },
    count: String(count),
    substatus,
    level: 'error',
});

const noul = (value: number) => json(200, { model: 'jev-1.14.0', answers: { answer: { type: 'noul', noul: value } }, usage: { input_tokens: 1 } });

describe('plan', () => {
    it('ranks, applies the rules, triages with Jev, and plans the issues to attempt', async () => {
        const github = new FakeGitHub();
        github.pr({ number: 10, state: 'closed', labels: ['sentry-autofix'], body: '<!-- sentry-issue: 2 -->' });
        github.pr({ number: 11, title: 'fix WEB-3 by hand' });
        const { options: sentry, calls } = fakeSentry(({ url }) => {
            const path = url.pathname;
            if (path === '/api/0/projects/o/oncourse-web/') return { id: '9', slug: 'oncourse-web' };
            if (path === '/api/0/organizations/o/issues/') {
                return [issueBody('1', 500), issueBody('2', 400), issueBody('3', 300), issueBody('4', 200), issueBody('5', 100), issueBody('6', 50, 'ongoing', 'other')];
            }
            if (path === '/api/0/organizations/o/issues/4/comments/') return [{ type: 'note', data: { text: '[sentry-fix] no-fix 2026-11-06' } }];
            if (path.endsWith('/comments/')) return [];
            if (path.endsWith('/events/latest/')) return { platform: 'javascript', entries: [] };
            throw new Error(`unexpected ${path}`);
        });
        const jevCalls: Call[] = [];
        const log: string[] = [];
        const result = await plan({
            octokit: github.octokit,
            repo: { owner: 'o', repo: 'r' },
            sentry,
            jev: jevOptions([noul(0.95), noul(0.1)], jevCalls, []),
            config,
            sha: 'b'.repeat(40),
            log: (message) => log.push(message),
        });
        expect(result.rows.map((row) => [row.issue.id, row.decision.kind === 'skip' ? row.decision.reason : 'attempt'])).toEqual([
            ['1', 'not-in-repo'],
            ['2', 'rejected-pr'],
            ['3', 'open-pr'],
            ['4', 'prior-no-fix'],
            ['5', 'attempt'],
        ]);
        expect(result.ranked).toBe(5);
        expect(result.planned).toHaveLength(1);
        expect(result.planned[0]).toMatchObject({ sha: 'b'.repeat(40), period: '7d', project: { slug: 'oncourse-web' }, context: { issue: { id: '5', count: 100 } } });
        expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
        expect(log).toEqual([]);

        const table = renderWalk(result, config, true);
        expect(table).toContain('## Sentry fix plan (dry run)');
        expect(table).toContain('| 1 | [WEB-1](https://sentry.io/issues/1/) Error 1 | oncourse-web | 500 | skip: not-in-repo | Jev 0.95 | not-in-repo 0.95 |');
        expect(table).toContain('| 5 | [WEB-5](https://sentry.io/issues/5/) Error 5 | oncourse-web | 100 | attempt |  | not-in-repo 0.10 |');
    });
});
