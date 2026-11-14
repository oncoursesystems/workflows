import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionLimitError, UsageLimitError, type AgentRequest, type RunAgent } from '../review/agent.ts';
import type { FixOutput } from './fix.ts';
import { runFixer, type FixerOptions } from './fixer.ts';
import type { PlannedIssue } from './handoff.ts';
import { issueContextOf } from './testing.ts';

const output: FixOutput = {
    outcome: 'fixed',
    confidence: 'high',
    rootCause: 'cause',
    analysis: 'analysis',
    commitTitle: 'fix(grid): guard',
    testAdded: 'client/web/grid.test.js',
};

const stats = { model: 'claude-opus-5-5', billing: 'subscription' as const, tools: {}, costUsd: 1.5, turns: 12, durationMs: 1000, denied: ['Bash(curl x)'] };

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
            project: { slug: 'oncourse-web', description: 'client', roots: ['client/web'] },
            context: issueContextOf(),
        };
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const agent = (edit: () => void, outcome: FixOutput | Error = output) => {
        const requests: AgentRequest<FixOutput>[] = [];
        const runAgent = (async (request: AgentRequest<FixOutput>) => {
            requests.push(request);
            edit();
            if (outcome instanceof Error) throw outcome;
            return { output: outcome, stats };
        }) as RunAgent;
        return { runAgent, requests };
    };

    const run = (runAgent: RunAgent, fields: Partial<FixerOptions> = {}) => runFixer({ planned, cwd: dir, runAgent, env: {}, secrets: () => [], ...fields });

    it('runs the fixer with its tools and env, and collects every change in the working tree', async () => {
        const { runAgent, requests } = agent(() => {
            writeFileSync(join(dir, 'client/web/grid.js'), 'if (store) load();\n');
            writeFileSync(join(dir, 'client/web/grid.test.js'), 'test();\n');
            unlinkSync(join(dir, 'client/web/old.js'));
        });
        const result = await run(runAgent, { env: { PATH: '/usr/bin' } });
        expect(requests[0]).toMatchObject({
            model: 'claude-opus-5-5',
            maxBudgetUsd: 10,
            cwd: dir,
            env: { PATH: '/usr/bin' },
            tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
            allowedTools: ['Edit(./client/web/**)'],
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
        const { runAgent } = agent(() => {
            writeFileSync(join(dir, 'CLAUDE.md'), 'changed\n');
            writeFileSync(join(dir, 'client/web/grid.js'), 'const t = "sk-ant-oat01-secret";\n');
        });
        const result = await run(runAgent, { secrets: () => ['sk-ant-oat01-secret'] });
        expect(result.status === 'done' && result.gate).toEqual({
            open: false,
            reasons: ['`CLAUDE.md` is outside the project roots.', '`CLAUDE.md` is protected.', '`client/web/grid.js` contains a credential the fixer could see.'],
        });
    });

    it('never reads through a symlink', async () => {
        const { runAgent } = agent(() => symlinkSync('/etc/hostname', join(dir, 'client/web/link')));
        const result = await run(runAgent);
        expect(result.status === 'done' && result.changes).toEqual([{ path: 'client/web/link', status: 'added', mode: '120000', content: null }]);
        expect(result.status === 'done' && result.gate).toEqual({ open: false, reasons: ['`client/web/link` is not a regular file.'] });
    });

    it.each([new UsageLimitError('Claude hit its five_hour limit'), new Error('claude-opus-5-5 stopped with an error: overloaded')])(
        'reports a session that threw "$message" as failed, without a gate',
        async (error) => {
            const { runAgent } = agent(() => {}, error);
            await expect(run(runAgent)).resolves.toEqual({ status: 'failed', error: error.message });
        },
    );

    it('gates a no-fix answer shut', async () => {
        const { runAgent } = agent(() => {}, { ...output, outcome: 'no-fix' });
        expect(await run(runAgent)).toMatchObject({ status: 'done', gate: { open: false } });
    });

    it('reports a session that ran out of budget or turns as exhausted, which is a no-fix', async () => {
        const { runAgent } = agent(() => {}, new SessionLimitError('claude-opus-5-5 stopped with error_max_budget_usd: over budget'));
        await expect(run(runAgent)).resolves.toEqual({
            status: 'exhausted',
            reason: 'The fixer ran out of budget or turns before it found a fix: claude-opus-5-5 stopped with error_max_budget_usd: over budget',
        });
    });

    it('refuses a checkout at another commit than the plan', async () => {
        const { runAgent, requests } = agent(() => {});
        const result = await run(runAgent, { planned: { ...planned, sha: 'f'.repeat(40) } });
        expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('but the plan was made at') });
        expect(requests).toEqual([]);
    });

    it('fails, and collects nothing, when the run changed .git/config or a .gitattributes', async () => {
        const pwned = `${dir}-pwned`;
        const { runAgent } = agent(() => {
            writeFileSync(join(dir, '.git/config'), `[filter "x"]\n\tclean = touch ${pwned}\n`, { flag: 'a' });
            writeFileSync(join(dir, 'client/web/.gitattributes'), '* filter=x\n');
            writeFileSync(join(dir, 'client/web/grid.js'), 'if (store) load();\n');
        });
        const result = await run(runAgent);
        expect(result).toEqual({
            status: 'failed',
            error: "the fixer's run changed `.git/config`, `client/web/.gitattributes`, which git on the runner reads, so nothing was collected",
        });
        expect(existsSync(pwned)).toBe(false);
    });
});
