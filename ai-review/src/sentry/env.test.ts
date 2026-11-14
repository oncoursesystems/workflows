import { describe, expect, it } from 'vitest';
import { agentEnv } from './env.ts';

const RUNNER = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: 'true',
    DOTNET_ROOT: '/usr/share/dotnet',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-subscription',
    GITHUB_TOKEN: 'ghs_workflow',
    GH_TOKEN: 'ghs_cli',
    INPUT_BOT_TOKEN: 'ghs_bot',
    SENTRY_TOKEN: 'sntrys_token',
    TYPESAFE_API_KEY: 'ts_key',
    ANTHROPIC_API_KEY: 'sk-ant-api',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'id-request',
    ACTIONS_RUNTIME_TOKEN: 'runtime',
    NUGET_AUTH_TOKEN: 'feed',
    GITHUB_WORKSPACE: '/work',
};

describe('agentEnv', () => {
    it('keeps the paths, the locale and the Claude token, and nothing else', () => {
        expect(agentEnv(RUNNER)).toEqual({
            PATH: '/usr/bin',
            HOME: '/home/runner',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            CI: 'true',
            CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-subscription',
        });
    });
});
