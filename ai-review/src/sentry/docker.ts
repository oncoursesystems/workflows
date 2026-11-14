import { spawn } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { containerEnv, dockerClientEnv, isVariableName } from './env.ts';
import { parseJson } from './handoff.ts';
import { REQUEST_FILE, SESSION_FILE, SessionResult, type SessionRequest } from './session.ts';

// Where the runner's directories appear inside a fixer container.
export const CONTAINER = {
    work: '/work',
    git: '/work/.git',
    harness: '/harness',
    node: '/opt/harness-node',
    session: '/session',
} as const;

export const LIMITS = { cpus: '2', memory: '8g', pids: '4096' } as const;

export const SESSION_TIMEOUT_MS = 50 * 60_000;

const SESSION_FILE_LIMIT = 4 * 1024 * 1024;

export type Mounts = {
    // The checkout, read-write. Its .git is mounted again on top, read-only.
    work: string;
    // The ai-review directory with its installed node_modules, read-only.
    harness: string;
    // The runner's Node.js install, read-only, so the entry point runs whatever Node.js the project uses.
    node: string;
    // The per-issue directory the entry point reads its request from and writes its result to.
    session?: string;
};

export type ContainerSpec = { image: string; name: string; user: string; mounts: Mounts; env: readonly string[] };

function bind(source: string, target: string, readonly: boolean): string[] {
    if (source.includes(',') || source.includes('\n')) throw new Error(`cannot mount ${JSON.stringify(source)}, because Docker's --mount splits on commas`);
    return ['--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`];
}

// Each variable goes in by name, so its value comes from the docker command's own env and never shows in its
// arguments, where any process on the runner can read it.
function envArgs(names: readonly string[]): string[] {
    return names.flatMap((name) => {
        if (!isVariableName(name)) throw new Error(`${JSON.stringify(name)} is not an environment variable name`);
        return ['--env', name];
    });
}

// No Docker socket, no host PID or network namespace and no privileges: code the fixer runs sees only the checkout.
export function containerArgs(spec: ContainerSpec): string[] {
    const { mounts } = spec;
    return [
        '--name',
        spec.name,
        '--init',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        spec.user,
        '--cpus',
        LIMITS.cpus,
        '--memory',
        LIMITS.memory,
        '--pids-limit',
        LIMITS.pids,
        '--workdir',
        CONTAINER.work,
        ...bind(mounts.work, CONTAINER.work, false),
        ...bind(join(mounts.work, '.git'), CONTAINER.git, true),
        ...bind(mounts.harness, CONTAINER.harness, true),
        ...bind(mounts.node, CONTAINER.node, true),
        ...(mounts.session === undefined ? [] : bind(mounts.session, CONTAINER.session, false)),
        ...envArgs(spec.env),
    ];
}

export const sessionArgs = (spec: ContainerSpec): string[] => [
    'run',
    '--rm',
    ...containerArgs(spec),
    spec.image,
    `${CONTAINER.node}/bin/node`,
    '--experimental-strip-types',
    '--no-warnings=ExperimentalWarning',
    `${CONTAINER.harness}/src/sentry/inner.ts`,
];

export type ProcessRun = { exitCode: number | null; tail: string; timedOut: boolean };

const TAIL_BYTES = 64 * 1024;

export type Spawner = (args: readonly string[], env: Record<string, string>, options: { timeoutMs: number; echo: boolean; onTimeout: () => Promise<void> }) => Promise<ProcessRun>;

export const spawnDocker: Spawner = (args, env, { timeoutMs, echo, onTimeout }) =>
    new Promise((resolve, reject) => {
        const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let tail = Buffer.alloc(0);
        const keep = (chunk: Buffer) => {
            if (echo) process.stdout.write(chunk);
            tail = Buffer.concat([tail, chunk]);
            if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            void onTimeout().finally(() => child.kill('SIGKILL'));
        }, timeoutMs);
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ exitCode: timedOut ? null : code, tail: tail.toString('utf8'), timedOut });
        });
    });

export type DockerContext = {
    image: string;
    name: string;
    user: string;
    mounts: Required<Mounts>;
    source: Readonly<Record<string, string | undefined>>;
    extraEnv: readonly string[];
    spawner?: Spawner;
};

const removeContainer = (context: DockerContext, name: string) => async (): Promise<void> => {
    await (context.spawner ?? spawnDocker)(['rm', '--force', name], dockerClientEnv(context.source, {}), { timeoutMs: 60_000, echo: false, onTimeout: async () => {} });
};

async function readSessionFile(path: string): Promise<string | undefined> {
    const stats = await lstat(path).catch(() => undefined);
    if (stats === undefined) return undefined;
    if (!stats.isFile() || stats.size > SESSION_FILE_LIMIT) throw new Error(`${path} is not a regular file under ${SESSION_FILE_LIMIT} bytes`);
    return readFile(path, 'utf8');
}

// Runs the agent session in a throwaway container and returns what its entry point wrote.
export async function runSessionContainer(context: DockerContext, request: SessionRequest): Promise<SessionResult> {
    const { mounts } = context;
    await writeFile(join(mounts.session, REQUEST_FILE), JSON.stringify(request));
    const env = containerEnv(context.source, context.extraEnv, 'claude');
    const spec = { image: context.image, name: `${context.name}-session`, user: context.user, mounts, env: Object.keys(env) };
    const run = await (context.spawner ?? spawnDocker)(sessionArgs(spec), dockerClientEnv(context.source, env), {
        timeoutMs: SESSION_TIMEOUT_MS,
        echo: true,
        onTimeout: removeContainer(context, spec.name),
    });
    if (run.timedOut) return { status: 'exhausted', error: `the session ran past ${SESSION_TIMEOUT_MS / 60_000} minutes` };
    const text = await readSessionFile(join(mounts.session, SESSION_FILE));
    if (text === undefined) throw new Error(`the session container exited with ${run.exitCode} and wrote no result: ${run.tail.slice(-2000)}`);
    return parseJson(text, SessionResult, 'the session result');
}
