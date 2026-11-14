import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixOutput } from './fix.ts';
import { runFixer, type Containers } from './fixer.ts';
import type { PlannedIssue } from './handoff.ts';
import type { SessionRequest, SessionResult } from './session.ts';
import { issueContextOf } from './testing.ts';

const output: FixOutput = {
    outcome: 'fixed',
    confidence: 'high',
    rootCause: 'cause',
    analysis: 'analysis',
    commitTitle: 'fix(grid): guard',
    testAdded: 'client/web/grid.test.js',
    verification: [{ command: 'npm test', passed: true }],
};

const stats = { billing: 'subscription', costUsd: 1.5, turns: 12, durationMs: 1000, denied: ['Bash(curl x)'] };

describe('runFixer', () => {
    let dir: string;
    let planned: PlannedIssue;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'sentry-fixer-'));
        git('init', '--quiet', '--initial-branch=main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 'Test');
        mkdirSync(join(dir, 'client/web'), { recursive: true });
        writeFileSync(join(dir, 'client/web/grid.js'), 'load();\n');
        writeFileSync(join(dir, 'client/web/old.js'), 'old();\n');
        writeFileSync(join(dir, 'CLAUDE.md'), 'Use 4 spaces.\n');
        git('add', '.');
        git('commit', '--quiet', '-m', 'base');
        planned = {
            sha: git('rev-parse', 'HEAD'),
            period: '7d',
            project: { slug: 'oncourse-web', description: 'client', roots: ['client/web'], commands: ['npm test'], env: [] },
            context: issueContextOf(),
        };
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const agent = (edit: () => void, result: SessionResult = { status: 'done', output, stats }) => {
        const requests: SessionRequest[] = [];
        const containers: Containers = {
            session: async (request) => {
                requests.push(request);
                edit();
                return result;
            },
        };
        return { containers, requests };
    };

    it('runs the fixer with its tools and env, and collects every change in the working tree', async () => {
        const { containers, requests } = agent(() => {
            writeFileSync(join(dir, 'client/web/grid.js'), 'if (store) load();\n');
            writeFileSync(join(dir, 'client/web/grid.test.js'), 'test();\n');
            unlinkSync(join(dir, 'client/web/old.js'));
        });
        const result = await runFixer({ planned, cwd: dir, containers, secrets: () => [] });
        expect(requests[0]).toMatchObject({
            model: 'claude-opus-5-5',
            maxBudgetUsd: 10,
            allowedTools: ['Read', 'Grep', 'Glob', 'Edit(./client/web/**)', 'Bash(npm test)'],
        });
        expect(requests[0]?.systemPrompt).toContain('Use 4 spaces.');
        expect(result).toMatchObject({ status: 'done', gate: { open: true }, stats: { costUsd: 1.5, denied: ['Bash(curl x)'] } });
        if (result.status !== 'done') return;
        expect(result.changes.map(({ path, status, content }) => [path, status, content && Buffer.from(content, 'base64').toString()])).toEqual([
            ['client/web/grid.js', 'modified', 'if (store) load();\n'],
            ['client/web/old.js', 'deleted', null],
            ['client/web/grid.test.js', 'added', 'test();\n'],
        ]);
    });

    it('shuts the gate on a change outside the roots, and on a credential in the diff', async () => {
        const { containers } = agent(() => {
            writeFileSync(join(dir, 'CLAUDE.md'), 'changed\n');
            writeFileSync(join(dir, 'client/web/grid.js'), 'const t = "sk-ant-oat01-secret";\n');
        });
        const result = await runFixer({ planned, cwd: dir, containers, secrets: () => ['sk-ant-oat01-secret'] });
        expect(result.status === 'done' && result.gate).toEqual({
            open: false,
            reasons: ['`CLAUDE.md` is outside the project roots.', '`CLAUDE.md` is protected.', '`client/web/grid.js` contains a credential the fixer could see.'],
        });
    });

    it('never reads through a symlink', async () => {
        const { containers } = agent(() => symlinkSync('/etc/hostname', join(dir, 'client/web/link')));
        const result = await runFixer({ planned, cwd: dir, containers, secrets: () => [] });
        expect(result.status === 'done' && result.changes).toEqual([{ path: 'client/web/link', status: 'added', mode: '120000', content: null }]);
        expect(result.status === 'done' && result.gate).toEqual({ open: false, reasons: ['`client/web/link` is not a regular file.'] });
    });

    it.each([
        { status: 'usage-limit', error: 'Claude hit its five_hour limit' },
        { status: 'error', error: 'claude-opus-5-5 stopped with an error: overloaded' },
    ] as const)('reports a $status session as failed, without a gate', async (session) => {
        const { containers } = agent(() => {}, session);
        await expect(runFixer({ planned, cwd: dir, containers, secrets: () => [] })).resolves.toEqual({ status: 'failed', error: session.error });
    });

    it('reports a session container that broke as failed', async () => {
        const containers: Containers = {
            session: async () => {
                throw new Error('the session container exited with 125 and wrote no result');
            },
        };
        await expect(runFixer({ planned, cwd: dir, containers, secrets: () => [] })).resolves.toEqual({
            status: 'failed',
            error: 'the session container failed: the session container exited with 125 and wrote no result',
        });
    });

    it('refuses a checkout at another commit than the plan', async () => {
        const { containers, requests } = agent(() => {});
        const result = await runFixer({ planned: { ...planned, sha: 'f'.repeat(40) }, cwd: dir, containers, secrets: () => [] });
        expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('but the plan was made at') });
        expect(requests).toEqual([]);
    });

    it('fails, and collects nothing, when the run changed .git/config or a .gitattributes', async () => {
        const pwned = `${dir}-pwned`;
        const { containers } = agent(() => {
            writeFileSync(join(dir, '.git/config'), `[filter "x"]\n\tclean = touch ${pwned}\n`, { flag: 'a' });
            writeFileSync(join(dir, 'client/web/.gitattributes'), '* filter=x\n');
            writeFileSync(join(dir, 'client/web/grid.js'), 'if (store) load();\n');
        });
        const result = await runFixer({ planned, cwd: dir, containers, secrets: () => [] });
        expect(result).toEqual({
            status: 'failed',
            error: "the fixer's run changed `.git/config`, `client/web/.gitattributes`, which git on the runner reads, so nothing was collected",
        });
        expect(existsSync(pwned)).toBe(false);
    });
});
