import { describe, expect, it } from 'vitest';
import { agentEnv, isSecretName } from './env.ts';

const RUNNER = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    DOTNET_ROOT: '/usr/share/dotnet',
    NUGET_PACKAGES: '/home/runner/.nuget',
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
    UNLISTED: 'value',
};

describe('agentEnv', () => {
    it('keeps the toolchain, the locale and the Claude auth variable', () => {
        const env = agentEnv(RUNNER, ['NUGET_PACKAGES']);
        expect(env).toEqual({
            PATH: '/usr/bin',
            HOME: '/home/runner',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            DOTNET_ROOT: '/usr/share/dotnet',
            NUGET_PACKAGES: '/home/runner/.nuget',
            CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-subscription',
            CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
        });
    });

    it('never passes on a token, a key, or the ID token request, even when a project asks for one', () => {
        const env = agentEnv(RUNNER, ['GITHUB_TOKEN', 'SENTRY_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'NUGET_AUTH_TOKEN']);
        const values = Object.values(env);
        for (const secret of ['ghs_workflow', 'ghs_cli', 'ghs_bot', 'ghs_input', 'sntrys_token', 'ts_key', 'sk-ant-api', 'id-request', 'runtime', 'feed']) {
            expect(values).not.toContain(secret);
        }
        expect(Object.keys(env).filter((name) => name.startsWith('ACTIONS_') || name.startsWith('GITHUB_'))).toEqual([]);
    });

    it('leaves out a variable nobody listed', () => {
        expect(agentEnv(RUNNER, [])).not.toHaveProperty('UNLISTED');
    });
});

describe('isSecretName', () => {
    it.each(['GITHUB_TOKEN', 'MY_API_KEY', 'DB_PASSWORD', 'ACTIONS_CACHE_URL', 'INPUT_SENTRY-TOKEN', 'TYPESAFE_API_KEY', 'NPM_CONFIG_USERCONFIG'])(
        'treats %s as a secret',
        (name) => expect(isSecretName(name)).toBe(true),
    );

    it.each(['NUGET_PACKAGES', 'DOTNET_ROOT', 'NODE_OPTIONS', 'KEYBOARD'])('lets %s through', (name) => expect(isSecretName(name)).toBe(false));
});
