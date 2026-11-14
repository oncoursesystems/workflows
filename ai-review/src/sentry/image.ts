import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { dockerClientEnv } from './env.ts';
import { spawnDocker, type Spawner } from './docker.ts';

export type ImageArgs = { dotnetSdkVersion: string; nodeVersion: string };

export const DEFAULT_IMAGE_ARGS: ImageArgs = { dotnetSdkVersion: '10.0', nodeVersion: '24' };

const BUILD_TIMEOUT_MS = 30 * 60_000;

// An mcr.microsoft.com/dotnet/sdk tag, and a Node.js major or exact version on nodejs.org.
const DOTNET_VERSION = /^\d+\.\d+(\.\d+)?(-[0-9A-Za-z.]+)?$/;
const NODE_VERSION = /^\d+(\.\d+\.\d+)?$/;

const GlobalJson = z.object({ sdk: z.object({ version: z.string().regex(DOTNET_VERSION) }) });

export function sdkVersionOf(globalJson: string): string {
    const parsed = GlobalJson.safeParse(JSON.parse(globalJson));
    if (!parsed.success) throw new Error('global.json names no .NET SDK version in sdk.version');
    return parsed.data.sdk.version;
}

export function imageArgs(inputs: { dotnetVersion: string; nodeVersion: string; globalJson: string | undefined }): ImageArgs {
    const dotnetSdkVersion = inputs.globalJson !== undefined ? sdkVersionOf(inputs.globalJson) : inputs.dotnetVersion || DEFAULT_IMAGE_ARGS.dotnetSdkVersion;
    const nodeVersion = inputs.nodeVersion.replace(/^v/, '') || DEFAULT_IMAGE_ARGS.nodeVersion;
    if (!DOTNET_VERSION.test(dotnetSdkVersion)) throw new Error(`${dotnetSdkVersion} is not a .NET SDK image tag`);
    if (!NODE_VERSION.test(nodeVersion)) throw new Error(`${nodeVersion} is not a Node.js major or exact version`);
    return { dotnetSdkVersion, nodeVersion };
}

// The same Dockerfile and arguments give the same tag, so a runner's layer cache serves every later run.
export const imageTag = (dockerfile: Uint8Array, args: ImageArgs): string =>
    `sentry-fix-runner:${createHash('sha256').update(dockerfile).update(`\0${args.dotnetSdkVersion}\0${args.nodeVersion}`).digest('hex').slice(0, 16)}`;

export const buildArgs = (dockerfilePath: string, tag: string, args: ImageArgs): string[] => [
    'buildx',
    'build',
    '--load',
    '--tag',
    tag,
    '--build-arg',
    `DOTNET_SDK_VERSION=${args.dotnetSdkVersion}`,
    '--build-arg',
    `NODE_VERSION=${args.nodeVersion}`,
    '--file',
    dockerfilePath,
    dirname(dockerfilePath),
];

export async function buildImage(
    dockerfilePath: string,
    args: ImageArgs,
    source: Readonly<Record<string, string | undefined>>,
    spawner: Spawner = spawnDocker,
): Promise<string> {
    const tag = imageTag(await readFile(dockerfilePath), args);
    const run = await spawner(buildArgs(dockerfilePath, tag, args), dockerClientEnv(source, {}), { timeoutMs: BUILD_TIMEOUT_MS, echo: true, onTimeout: async () => {} });
    if (run.exitCode !== 0) throw new Error(`docker buildx build of ${tag} exited with ${run.exitCode}: ${run.tail.slice(-2000)}`);
    return tag;
}
