import { describe, expect, it } from 'vitest';
import { buildArgs, imageArgs, imageTag, sdkVersionOf } from './image.ts';

describe('imageArgs', () => {
    it('defaults to .NET 10 and Node.js 24', () => {
        expect(imageArgs({ dotnetVersion: '', nodeVersion: '', globalJson: undefined })).toEqual({ dotnetSdkVersion: '10.0', nodeVersion: '24' });
    });

    it('takes the SDK from global.json over the dotnet-version input', () => {
        const globalJson = JSON.stringify({ sdk: { version: '10.0.100', rollForward: 'latestFeature' } });
        expect(imageArgs({ dotnetVersion: '8.0', nodeVersion: 'v20.18.1', globalJson })).toEqual({ dotnetSdkVersion: '10.0.100', nodeVersion: '20.18.1' });
    });

    it('refuses a version that is not an image tag or a Node.js release', () => {
        expect(() => imageArgs({ dotnetVersion: '10.0; rm -rf /', nodeVersion: '', globalJson: undefined })).toThrow('is not a .NET SDK image tag');
        expect(() => imageArgs({ dotnetVersion: '', nodeVersion: 'lts/*', globalJson: undefined })).toThrow('is not a Node.js major or exact version');
        expect(() => sdkVersionOf('{"msbuild-sdks":{}}')).toThrow('names no .NET SDK version');
    });
});

describe('imageTag', () => {
    const dockerfile = Buffer.from('FROM x\n');
    const args = { dotnetSdkVersion: '10.0', nodeVersion: '24' };

    it('is the same for the same Dockerfile and arguments, and differs when either changes', () => {
        expect(imageTag(dockerfile, args)).toMatch(/^sentry-fix-runner:[0-9a-f]{16}$/);
        expect(imageTag(dockerfile, args)).toBe(imageTag(Buffer.from('FROM x\n'), { ...args }));
        expect(imageTag(dockerfile, { ...args, nodeVersion: '22' })).not.toBe(imageTag(dockerfile, args));
        expect(imageTag(Buffer.from('FROM y\n'), args)).not.toBe(imageTag(dockerfile, args));
    });

    it('builds from the action directory with both versions as build arguments', () => {
        expect(buildArgs('/a/sentry-fix-run/Dockerfile', 'sentry-fix-runner:1', args)).toEqual([
            'buildx',
            'build',
            '--load',
            '--tag',
            'sentry-fix-runner:1',
            '--build-arg',
            'DOTNET_SDK_VERSION=10.0',
            '--build-arg',
            'NODE_VERSION=24',
            '--file',
            '/a/sentry-fix-run/Dockerfile',
            '/a/sentry-fix-run',
        ]);
    });
});
