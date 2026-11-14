import { describe, expect, it } from 'vitest';
import type { SentryFixConfig } from './config.ts';
import { FakeGitHub } from './fake-github.ts';
import type { FixOutput } from './fix.ts';
import type { ChangedFile, FixResult, PlannedIssue } from './handoff.ts';
import { publish } from './publish.ts';
import { fakeSentry, issueContextOf, sentryIssue, type SentryCall } from './testing.ts';

const project = { slug: 'oncourse-web', description: 'client', roots: ['client/web'], commands: ['npm test'], env: [] };
const config: SentryFixConfig = { limit: 5, environment: 'production', period: '7d', projects: [project], apps: [] };

const planned: PlannedIssue = {
    sha: 'a'.repeat(40),
    period: '7d',
    project,
    context: issueContextOf(sentryIssue({ id: '101', shortId: 'ONCOURSE-WEB-3K', count: 1234 })),
};

const output: FixOutput = {
    outcome: 'fixed',
    confidence: 'high',
    rootCause: 'The grid loads before the period store.',
    analysis: 'Wait for the store.',
    commitTitle: 'fix(gradebook): wait for the period store',
    testAdded: 'client/web/test/Grid.test.js',
    verification: [{ command: 'npm test', passed: true }],
};

const file = (path: string, text: string | null, status: ChangedFile['status'] = 'modified'): ChangedFile => ({
    path,
    status,
    mode: text === null ? '000000' : '100644',
    content: text === null ? null : Buffer.from(text).toString('base64'),
});

const done = (fields: Partial<Extract<FixResult, { status: 'done' }>> = {}): FixResult => ({
    status: 'done',
    planned,
    output,
    gate: { open: true },
    changes: [file('client/web/app/Grid.js', 'fixed();\n'), file('client/web/test/Grid.test.js', 'test();\n', 'added'), file('client/web/old.js', null, 'deleted')],
    stats: { billing: 'subscription', costUsd: 2, turns: 30, durationMs: 1, denied: [] },
    ...fields,
});

const setup = (notes: string[] = []) => {
    const github = new FakeGitHub();
    const posted: string[] = [];
    const { options: sentry, calls } = fakeSentry(({ method, body }: SentryCall) => {
        if (method === 'GET') return [...notes, ...posted].map((text) => ({ type: 'note', data: { text } }));
        posted.push((body as { text: string }).text);
        return {};
    });
    const options = { octokit: github.octokit, repo: { owner: 'o', repo: 'r' }, sentry, config, now: new Date('2026-11-13T12:00:00Z') };
    return { github, posted, calls, options };
};

describe('publish', () => {
    it('commits through the API, opens a ready pull request with the label, and notes it on Sentry', async () => {
        const { github, posted, options } = setup();
        const result = await publish(done(), options);
        expect(result).toEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/101', created: true });

        const head = github.refs.get('heads/sentry-fix/oncourse-web-3k')!;
        const commit = github.commits.get(head)!;
        expect(commit).toMatchObject({ message: 'fix(gradebook): wait for the period store', parents: ['a'.repeat(40)] });
        expect(github.trees.get(commit.tree)?.entries).toEqual([
            { path: 'client/web/app/Grid.js', mode: '100644', type: 'blob', sha: expect.any(String) },
            { path: 'client/web/test/Grid.test.js', mode: '100644', type: 'blob', sha: expect.any(String) },
            { path: 'client/web/old.js', mode: '100644', type: 'blob', sha: null },
        ]);
        expect([...github.blobs.values()]).toEqual(['fixed();\n', 'test();\n']);

        const pr = github.prs.find((candidate) => candidate.number === 101)!;
        expect(github.calls).toContain('create sentry-fix/oncourse-web-3k -> main');
        expect(pr.title).toBe('fix(gradebook): wait for the period store');
        expect(pr.labels).toEqual(['sentry-autofix']);
        expect(github.repoLabels).toEqual(['sentry-autofix']);
        expect(pr.body).toContain('[ONCOURSE-WEB-3K](https://sentry.io/organizations/o/issues/101/) in `oncourse-web` had 1,234 events in the last 7 days.');
        expect(pr.body).toContain('Fixes ONCOURSE-WEB-3K');
        expect(pr.body).toContain('app/view/gradebook/Grid.js:42 in onLoad');
        expect(pr.body).toContain('| `npm test` | passed |');
        expect(pr.body).toContain('`client/web/test/Grid.test.js`');
        expect(pr.body.trimEnd().endsWith('<!-- sentry-issue: 101 -->')).toBe(true);
        expect(posted).toEqual([
            '[sentry-fix] pr https://github.com/o/r/pull/101\n\nOpened a fix: fix(gradebook): wait for the period store\n\nRoot cause: The grid loads before the period store.',
        ]);
    });

    it('converges on a rerun: the same branch, the same pull request, and no second note', async () => {
        const { github, posted, options } = setup();
        await publish(done(), options);
        const head = github.refs.get('heads/sentry-fix/oncourse-web-3k');
        github.calls = [];
        const again = await publish(done(), options);
        expect(again).toEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/101', created: false });
        expect(github.refs.get('heads/sentry-fix/oncourse-web-3k')).toBe(head);
        expect(github.calls).toEqual(['update #101', 'addLabels #101 sentry-autofix']);
        expect(github.prs).toHaveLength(1);
        expect(posted).toHaveLength(1);
    });

    it('moves the branch of a closed pull request to the new fix and opens a new one', async () => {
        const { github, options } = setup();
        github.refs.set('heads/sentry-fix/oncourse-web-3k', 'a'.repeat(40));
        github.pr({ number: 50, state: 'closed', head: 'sentry-fix/oncourse-web-3k', labels: ['sentry-autofix'] });
        await publish(done(), options);
        expect(github.calls).toContain('updateRef heads/sentry-fix/oncourse-web-3k force');
        expect(github.calls).toContain('create sentry-fix/oncourse-web-3k -> main');
    });

    it('posts the analysis to Sentry and opens nothing when the fixer found no fix', async () => {
        const { github, posted, options } = setup();
        const noFix = done({ output: { ...output, outcome: 'no-fix', analysis: 'The error is raised by PL/SQL.' }, gate: { open: false, reasons: ['Claude found no confident fix.'] }, changes: [] });
        expect(await publish(noFix, options)).toEqual({ kind: 'no-fix', reasons: ['Claude found no confident fix.', 'The working tree has no changes.'] });
        expect(github.calls).toEqual([]);
        expect(posted[0]).toMatch(/^\[sentry-fix\] no-fix 2026-11-13\n/);
        expect(posted[0]).toContain('- Claude found no confident fix.');
        expect(posted[0]).toContain('The error is raised by PL/SQL.');
    });

    it('checks the gate again, so an artifact with a protected path opens nothing', async () => {
        const { github, posted, options } = setup();
        const tampered = done({ changes: [file('.github/workflows/ci.yml', 'evil')] });
        expect(await publish(tampered, options)).toEqual({
            kind: 'no-fix',
            reasons: ['`.github/workflows/ci.yml` is outside the project roots.', '`.github/workflows/ci.yml` is protected.'],
        });
        expect(github.calls).toEqual([]);
        expect(posted).toHaveLength(1);
    });

    it('does not post the same no-fix note twice in a day', async () => {
        const { posted, options } = setup(['[sentry-fix] no-fix 2026-11-13\n\nearlier run']);
        await publish(done({ output: { ...output, outcome: 'no-fix' } }), options);
        expect(posted).toEqual([]);
    });

    it('publishes nothing and notes nothing when the fixer did not finish', async () => {
        const { github, calls, options } = setup();
        expect(await publish({ status: 'failed', planned, error: 'usage limit' }, options)).toEqual({
            kind: 'not-published',
            reason: 'the fixer did not finish: usage limit',
        });
        expect(github.calls).toEqual([]);
        expect(calls).toEqual([]);
    });
});
