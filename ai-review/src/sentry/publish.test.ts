import { describe, expect, it } from 'vitest';
import type { SentryFixConfig } from './config.ts';
import { FakeGitHub, PERSON } from './fake-github.ts';
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
    output,
    verification: [{ command: 'npm test', exitCode: 0, tail: '12 passing' }],
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
    const options = { octokit: github.octokit, repo: { owner: 'o', repo: 'r' }, sentry, config, now: new Date('2026-11-13T12:00:00Z'), run: '777' };
    return { github, posted, calls, options };
};

describe('publish', () => {
    it('commits through the API, opens a ready pull request with the label, and notes it on Sentry', async () => {
        const { github, posted, options } = setup();
        const result = await publish(planned, done(), options);
        expect(result).toEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/101', created: true, branch: 'created' });

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
        expect(pr.body).toContain('ran each project command once more, in a fresh container');
        expect(pr.body).toContain('| `npm test` | passed |');
        expect(pr.body).toContain("Claude's own report of its runs, which does not decide the gate");
        expect(pr.body).toContain('`client/web/test/Grid.test.js`');
        expect(pr.body.trimEnd().endsWith('<!-- sentry-issue: 101 -->')).toBe(true);
        expect(posted).toEqual([
            '[sentry-fix] pr https://github.com/o/r/pull/101\n\nOpened a fix: fix(gradebook): wait for the period store\n\n' +
                'Root cause: The grid loads before the period store.\n\nThe workflow ran the project commands itself:\n\n- `npm test` passed\n',
        ]);
    });

    it('converges on a rerun: the same branch, the same pull request, and no second note', async () => {
        const { github, posted, options } = setup();
        await publish(planned, done(), options);
        const head = github.refs.get('heads/sentry-fix/oncourse-web-3k');
        github.calls = [];
        const again = await publish(planned, done(), options);
        expect(again).toEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/101', created: false, branch: 'unchanged' });
        expect(github.refs.get('heads/sentry-fix/oncourse-web-3k')).toBe(head);
        expect(github.calls).toEqual(['update #101', 'addLabels #101 sentry-autofix']);
        expect(github.prs).toHaveLength(1);
        expect(posted).toHaveLength(1);
    });

    it('moves the branch of a closed pull request to the new fix and opens a new one', async () => {
        const { github, options } = setup();
        github.refs.set('heads/sentry-fix/oncourse-web-3k', 'a'.repeat(40));
        github.pr({ number: 50, state: 'closed', head: 'sentry-fix/oncourse-web-3k', labels: ['sentry-autofix'] });
        await publish(planned, done(), options);
        expect(github.calls).toContain('updateRef heads/sentry-fix/oncourse-web-3k force');
        expect(github.calls).toContain('create sentry-fix/oncourse-web-3k -> main');
    });

    it('leaves the branch of an open pull request alone when a person pushed to it, and refreshes only the body', async () => {
        const { github, options } = setup();
        github.commits.set('f'.repeat(40), { message: 'fixup', tree: 't9', parents: ['a'.repeat(40)], committer: PERSON });
        github.refs.set('heads/sentry-fix/oncourse-web-3k', 'f'.repeat(40));
        github.pr({ number: 60, title: 'a reviewer title', body: 'old', head: 'sentry-fix/oncourse-web-3k', labels: ['sentry-autofix'] });
        const result = await publish(planned, done(), options);
        expect(result).toEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/60', created: false, branch: 'kept' });
        expect(github.refs.get('heads/sentry-fix/oncourse-web-3k')).toBe('f'.repeat(40));
        expect(github.calls.filter((call) => call.startsWith('updateRef') || call.startsWith('createRef') || call.startsWith('create sentry'))).toEqual([]);
        const pr = github.prs.find((candidate) => candidate.number === 60)!;
        expect(pr.title).toBe('a reviewer title');
        expect(pr.body).toContain('Fixes ONCOURSE-WEB-3K');
    });

    it('moves its own earlier commit on an open pull request to the new fix', async () => {
        const { github, options } = setup();
        await publish(planned, done(), options);
        const first = github.refs.get('heads/sentry-fix/oncourse-web-3k');
        const changed = done({ changes: [file('client/web/app/Grid.js', 'fixed better();\n')] });
        expect(await publish(planned, changed, options)).toMatchObject({ kind: 'pr', created: false, branch: 'moved' });
        expect(github.refs.get('heads/sentry-fix/oncourse-web-3k')).not.toBe(first);
    });

    it('posts the analysis to Sentry and opens nothing when the fixer found no fix', async () => {
        const { github, posted, options } = setup();
        const noFix = done({ output: { ...output, outcome: 'no-fix', analysis: 'The error is raised by PL/SQL.' }, gate: { open: false, reasons: ['Claude found no confident fix.'] }, changes: [] });
        expect(await publish(planned, noFix, options)).toEqual({ kind: 'no-fix', reasons: ['Claude found no confident fix.', 'The working tree has no changes.'] });
        expect(github.calls).toEqual([]);
        expect(posted[0]).toMatch(/^\[sentry-fix\] no-fix 2026-11-13 run 777\n/);
        expect(posted[0]).toContain('- Claude found no confident fix.');
        expect(posted[0]).toContain('The error is raised by PL/SQL.');
    });

    it("notes the workflow's failed run with the tail of its output", async () => {
        const { github, posted, options } = setup();
        const failing = done({ verification: [{ command: 'npm test', exitCode: 1, tail: 'AssertionError: expected 2 to be 3' }], gate: { open: false, reasons: [] } });
        expect(await publish(planned, failing, options)).toEqual({ kind: 'no-fix', reasons: ['`npm test` failed with exit code 1.'] });
        expect(github.calls).toEqual([]);
        expect(posted[0]).toContain('- `npm test` failed with exit code 1\n\n```\nAssertionError: expected 2 to be 3\n```');
    });

    it('checks the gate again, so a result whose runs were edited to pass opens nothing', async () => {
        const { github, options } = setup();
        const edited = done({ verification: [], gate: { open: true } });
        expect(await publish(planned, edited, options)).toEqual({ kind: 'no-fix', reasons: ['`npm test` did not run.'] });
        expect(github.calls).toEqual([]);
    });

    it('checks the gate again, so an artifact with a protected path opens nothing', async () => {
        const { github, posted, options } = setup();
        const tampered = done({ changes: [file('.github/workflows/ci.yml', 'evil')] });
        expect(await publish(planned, tampered, options)).toEqual({
            kind: 'no-fix',
            reasons: ['`.github/workflows/ci.yml` is outside the project roots.', '`.github/workflows/ci.yml` is protected.'],
        });
        expect(github.calls).toEqual([]);
        expect(posted).toHaveLength(1);
    });

    it('does not post a second no-fix note when the same run publishes again on another day', async () => {
        const { posted, options } = setup(['[sentry-fix] no-fix 2026-11-12 run 777\n\nfirst attempt of this run']);
        await publish(planned, done({ output: { ...output, outcome: 'no-fix' } }), options);
        expect(posted).toEqual([]);
    });

    it('publishes nothing and notes nothing when the fixer did not finish', async () => {
        const { github, calls, options } = setup();
        expect(await publish(planned, { status: 'failed', error: 'usage limit' }, options)).toEqual({
            kind: 'not-published',
            reason: 'the fixer did not finish: usage limit',
        });
        expect(github.calls).toEqual([]);
        expect(calls).toEqual([]);
    });
});
