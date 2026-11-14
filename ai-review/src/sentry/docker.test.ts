import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containerArgs, runSessionContainer, sessionArgs, type ContainerSpec, type DockerContext, type ProcessRun, type Spawner } from './docker.ts';
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
