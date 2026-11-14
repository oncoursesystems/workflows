import { describe, expect, it } from 'vitest';
import { containerEnv, dockerClientEnv, isSecretName } from './env.ts';

const RUNNER = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: 'true',
    DOTNET_ROOT: '/usr/share/dotnet',
    FEATURE_FLAGS: 'grid',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-subscription',
    GITHUB_TOKEN: 'ghs_workflow',
    GH_TOKEN: 'ghs_cli',
    INPUT_BOT_TOKEN: 'ghs_bot',
    'INPUT_GITHUB-TOKEN': 'ghs_input',
    SENTRY_TOKEN: 'sntrys_token',
    TYPESAFE_API_KEY: 'ts_key',
    ANTHROPIC_API_KEY: 'sk-ant-api',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'id-request',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions',
    ACTIONS_RUNTIME_TOKEN: 'runtime',
    NUGET_AUTH_TOKEN: 'feed',
    GITHUB_WORKSPACE: '/work',
    DOCKER_HOST: 'unix:///run/docker.sock',
    UNLISTED: 'value',
};

const SECRETS = ['ghs_workflow', 'ghs_cli', 'ghs_bot', 'ghs_input', 'sntrys_token', 'ts_key', 'sk-ant-api', 'id-request', 'runtime', 'feed'];

describe('containerEnv', () => {
    it('keeps the locale, the listed project variables and, for the agent, the Claude auth variable', () => {
        expect(containerEnv(RUNNER, ['FEATURE_FLAGS'], 'claude')).toEqual({
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            CI: 'true',
            FEATURE_FLAGS: 'grid',
            CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-subscription',
        });
    });

    it('leaves the Claude auth variable out of the verification container', () => {
        expect(containerEnv(RUNNER, ['FEATURE_FLAGS'], 'none')).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('never passes on a token, a key, or the ID token request, even when a project asks for one', () => {
        const env = containerEnv(RUNNER, ['GITHUB_TOKEN', 'SENTRY_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'NUGET_AUTH_TOKEN'], 'claude');
        const values = Object.values(env);
        for (const secret of SECRETS) expect(values).not.toContain(secret);
        expect(Object.keys(env).filter((name) => name.startsWith('ACTIONS_') || name.startsWith('GITHUB_'))).toEqual([]);
    });

    it('leaves the runner paths to the image, even when a project lists them', () => {
        const env = containerEnv(RUNNER, ['PATH', 'HOME'], 'none');
        expect(env).not.toHaveProperty('PATH');
        expect(env).not.toHaveProperty('HOME');
        expect(env).not.toHaveProperty('DOTNET_ROOT');
    });

    it('leaves out a variable nobody listed', () => {
        expect(containerEnv(RUNNER, [], 'claude')).not.toHaveProperty('UNLISTED');
    });
});

describe('dockerClientEnv', () => {
    it('is what finds the daemon plus the container variables, and no other runner secret', () => {
        const env = dockerClientEnv(RUNNER, containerEnv(RUNNER, [], 'claude'));
        expect(Object.keys(env).sort()).toEqual(['CI', 'CLAUDE_CODE_OAUTH_TOKEN', 'DOCKER_HOST', 'HOME', 'LANG', 'LC_ALL', 'PATH']);
        for (const secret of SECRETS) expect(Object.values(env)).not.toContain(secret);
    });
});

describe('isSecretName', () => {
    it.each(['GITHUB_TOKEN', 'MY_API_KEY', 'DB_PASSWORD', 'ACTIONS_CACHE_URL', 'INPUT_SENTRY-TOKEN', 'TYPESAFE_API_KEY', 'NPM_CONFIG_USERCONFIG'])(
        'treats %s as a secret',
        (name) => expect(isSecretName(name)).toBe(true),
    );

    it.each(['NUGET_PACKAGES', 'DOTNET_ROOT', 'NODE_OPTIONS', 'KEYBOARD'])('lets %s through', (name) => expect(isSecretName(name)).toBe(false));
});
