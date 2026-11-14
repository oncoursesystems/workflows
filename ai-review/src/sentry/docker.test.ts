import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containerArgs, outputTail, runSessionContainer, runVerification, sessionArgs, verifierArgs, type ContainerSpec, type DockerContext, type ProcessRun, type Spawner } from './docker.ts';
import type { SessionRequest } from './session.ts';

const TOKEN = 'sk-ant-oat01-subscription-secret';

const RUNNER = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    LANG: 'C.UTF-8',
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    GITHUB_TOKEN: 'ghs_workflow',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'id-request',
    ACTIONS_RUNTIME_TOKEN: 'runtime',
    FEATURE_FLAGS: 'grid',
};

const spec: ContainerSpec = {
    image: 'sentry-fix-runner:abc',
    name: 'sentry-fix-101-1-1-session',
    user: '1001:1001',
    mounts: { work: '/runner/_work/repo/repo', harness: '/runner/_work/_actions/workflows/ai-review', node: '/opt/node24', session: '/runner/_temp/session' },
    env: ['LANG', 'CLAUDE_CODE_OAUTH_TOKEN'],
};

const pairs = (args: readonly string[], flag: string): string[] => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]!] : []));

describe('containerArgs', () => {
    const args = containerArgs(spec);

    it('drops every capability and privilege, and limits CPU, memory and processes', () => {
        expect(pairs(args, '--cap-drop')).toEqual(['ALL']);
        expect(pairs(args, '--security-opt')).toEqual(['no-new-privileges']);
        expect(pairs(args, '--user')).toEqual(['1001:1001']);
        expect(pairs(args, '--cpus')).toEqual(['2']);
        expect(pairs(args, '--memory')).toEqual(['8g']);
        expect(pairs(args, '--pids-limit')).toEqual(['4096']);
    });

    it('shares no host namespace, mounts no Docker socket, and asks for no privilege', () => {
        const joined = args.join(' ');
        for (const flag of ['--privileged', '--pid', '--network', '--net', '--ipc', '--uts', '--userns', '--cap-add', '--device', '--volume', '-v']) {
            expect(args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false);
        }
        expect(joined).not.toContain('docker.sock');
    });

    it('mounts the checkout read-write with its .git read-only on top, and the harness and Node.js read-only', () => {
        expect(pairs(args, '--mount')).toEqual([
            'type=bind,source=/runner/_work/repo/repo,target=/work',
            'type=bind,source=/runner/_work/repo/repo/.git,target=/work/.git,readonly',
            'type=bind,source=/runner/_work/_actions/workflows/ai-review,target=/harness,readonly',
            'type=bind,source=/opt/node24,target=/opt/harness-node,readonly',
            'type=bind,source=/runner/_temp/session,target=/session',
        ]);
    });

    it('passes each variable by name only', () => {
        expect(pairs(args, '--env')).toEqual(['LANG', 'CLAUDE_CODE_OAUTH_TOKEN']);
        expect(() => containerArgs({ ...spec, env: [`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`] })).toThrow('is not an environment variable name');
    });

    it('refuses a path that would split the mount option', () => {
        expect(() => containerArgs({ ...spec, mounts: { ...spec.mounts, work: '/w,source=/' } })).toThrow("Docker's --mount splits on commas");
    });

    it('runs the entry point with the mounted Node.js in a container removed on exit', () => {
        const session = sessionArgs(spec);
        expect(session.slice(0, 2)).toEqual(['run', '--rm']);
        expect(session.slice(-5)).toEqual([
            'sentry-fix-runner:abc',
            '/opt/harness-node/bin/node',
            '--experimental-strip-types',
            '--no-warnings=ExperimentalWarning',
            '/harness/src/sentry/inner.ts',
        ]);
    });
});

describe('runSessionContainer', () => {
    let session: string;
    const request: SessionRequest = {
        model: 'claude-opus-5-5',
        systemPrompt: 's',
        prompt: 'p',
        effort: 'high',
        maxTurns: 150,
        maxBudgetUsd: 10,
        tools: ['Read'],
        allowedTools: ['Read'],
    };

    beforeEach(() => {
        session = mkdtempSync(join(tmpdir(), 'sentry-session-'));
    });

    afterEach(() => rmSync(session, { recursive: true, force: true }));

    const context = (spawner: Spawner): DockerContext => ({
        image: 'sentry-fix-runner:abc',
        name: 'sentry-fix-101-1-1',
        user: '1001:1001',
        mounts: { work: '/w', harness: '/h', node: '/n', session },
        source: RUNNER,
        extraEnv: ['FEATURE_FLAGS', 'GITHUB_TOKEN'],
        spawner,
    });

    const calls: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
    const spawner =
        (run: Partial<ProcessRun>, write?: (dir: string) => void): Spawner =>
        async (args, env) => {
            calls.push({ args, env });
            write?.(session);
            return { exitCode: 0, tail: '', timedOut: false, ...run };
        };

    it('never puts a secret value in the docker arguments, and hands the allowlist to docker by name', async () => {
        calls.length = 0;
        const done = { status: 'done', output: { outcome: 'no-fix', confidence: 'low', rootCause: 'r', analysis: 'a', commitTitle: 't', testAdded: null, verification: [] }, stats: { billing: 'subscription', costUsd: 1, turns: 2, durationMs: 3, denied: [] } };
        const result = await runSessionContainer(context(spawner({}, (dir) => writeFileSync(join(dir, 'session.json'), JSON.stringify(done)))), request);
        expect(result).toEqual(done);
        const [{ args, env }] = calls as [(typeof calls)[number]];
        for (const value of [TOKEN, 'ghs_workflow', 'id-request', 'runtime', 'grid']) expect(args.join('\0')).not.toContain(value);
        expect(pairs(args, '--env').sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'FEATURE_FLAGS', 'LANG']);
        expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/runner', LANG: 'C.UTF-8', CLAUDE_CODE_OAUTH_TOKEN: TOKEN, FEATURE_FLAGS: 'grid' });
    });

    it('fails with the tail of the output when the container wrote no result', async () => {
        await expect(runSessionContainer(context(spawner({ exitCode: 125, tail: 'docker: image not found' })), request)).rejects.toThrow(
            'the session container exited with 125 and wrote no result: docker: image not found',
        );
    });

    it('refuses a result the container replaced with a symlink', async () => {
        const write = (dir: string) => symlinkSync('/etc/hostname', join(dir, 'session.json'));
        await expect(runSessionContainer(context(spawner({}, write)), request)).rejects.toThrow('is not a regular file');
    });

    it('reports a session that ran past its time as exhausted', async () => {
        await expect(runSessionContainer(context(spawner({ exitCode: null, timedOut: true })), request)).resolves.toEqual({
            status: 'exhausted',
            error: 'the session ran past 50 minutes',
        });
    });
});

describe('runVerification', () => {
    type Call = { args: readonly string[]; env: Record<string, string> };

    const context = (spawner: Spawner): DockerContext => ({
        image: 'sentry-fix-runner:abc',
        name: 'sentry-fix-101-1-1',
        user: '1001:1001',
        mounts: { work: '/w', harness: '/h', node: '/n', session: '/s' },
        source: RUNNER,
        extraEnv: ['FEATURE_FLAGS'],
        spawner,
    });

    const recorder = (exec: (command: string) => Partial<ProcessRun>) => {
        const calls: Call[] = [];
        const spawner: Spawner = async (args, env) => {
            calls.push({ args, env });
            const run = args[0] === 'exec' ? exec(args.at(-1)!) : {};
            return { exitCode: 0, tail: '', timedOut: false, ...run };
        };
        return { calls, spawner };
    };

    it('starts one fresh container without the Claude token or the session directory, and records each real exit code', async () => {
        const { calls, spawner } = recorder((command) => (command === 'npm test' ? { exitCode: 1, tail: '\u001b[31m1 failing\u001b[0m\n' } : { tail: 'ok\n' }));
        const runs = await runVerification(context(spawner), ['npm ci', 'npm test']);
        expect(runs).toEqual([
            { command: 'npm ci', exitCode: 0, tail: 'ok' },
            { command: 'npm test', exitCode: 1, tail: '1 failing' },
        ]);
        expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
            ['run', '--rm', '--detach'],
            ['exec', 'sentry-fix-101-1-1-verify', 'bash'],
            ['exec', 'sentry-fix-101-1-1-verify', 'bash'],
            ['rm', '--force', 'sentry-fix-101-1-1-verify'],
        ]);
        const start = calls[0]!;
        expect(start.args.slice(-3)).toEqual(['sentry-fix-runner:abc', 'sleep', 'infinity']);
        expect(pairs(start.args, '--env').sort()).toEqual(['FEATURE_FLAGS', 'LANG']);
        expect(pairs(start.args, '--mount').some((mount) => mount.includes('target=/session'))).toBe(false);
        expect(pairs(start.args, '--mount')).toContain('type=bind,source=/w/.git,target=/work/.git,readonly');
        for (const call of calls) expect(Object.values(call.env)).not.toContain(TOKEN);
    });

    it('runs nothing after a command that did not finish, and still removes the container', async () => {
        const { calls, spawner } = recorder((command) => (command === 'npm ci' ? { exitCode: null, timedOut: true, tail: 'installing' } : {}));
        const runs = await runVerification(context(spawner), ['npm ci', 'npm test']);
        expect(runs).toEqual([
            { command: 'npm ci', exitCode: null, tail: 'Stopped after 20 minutes.\ninstalling' },
            { command: 'npm test', exitCode: null, tail: 'Not run, because an earlier command did not finish.' },
        ]);
        expect(calls.at(-1)?.args).toEqual(['rm', '--force', 'sentry-fix-101-1-1-verify']);
    });

    it('fails when the container does not start, and starts none for a project without commands', async () => {
        const failing: Spawner = async () => ({ exitCode: 125, tail: 'Unable to find image', timedOut: false });
        await expect(runVerification(context(failing), ['npm test'])).rejects.toThrow('the verification container did not start (125): Unable to find image');
        const { calls, spawner } = recorder(() => ({}));
        expect(await runVerification(context(spawner), [])).toEqual([]);
        expect(calls).toEqual([]);
    });

    it('keeps the end of long output', () => {
        expect(outputTail(`${'x'.repeat(5000)}end\n`)).toMatch(/^\.\.\.x+end$/);
        expect(outputTail(`${'x'.repeat(5000)}end`).length).toBe(3003);
        expect(verifierArgs(spec).slice(0, 3)).toEqual(['run', '--rm', '--detach']);
    });
});
