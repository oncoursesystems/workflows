export const CLAUDE_AUTH_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';

const BASE_VARIABLES = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TERM',
    'TMPDIR',
    'TZ',
    'LANG',
    'LANGUAGE',
    'CI',
    'DOTNET_ROOT',
    'DOTNET_NOLOGO',
    'DOTNET_CLI_TELEMETRY_OPTOUT',
    'DOTNET_SKIP_FIRST_TIME_EXPERIENCE',
    'JAVA_HOME',
];

const LOCALE = /^LC_[A-Z]+$/;

// GitHub, the runner, the action inputs and every service the job talks to put credentials in these.
const SECRET = /TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|_KEY$|^KEY$|^ACTIONS_|^GITHUB_|^RUNNER_|^INPUT_|^SENTRY_|^TYPESAFE_|^ANTHROPIC_|^GH_|^NUGET_AUTH|^NPM_CONFIG_/i;

export const isSecretName = (name: string): boolean => SECRET.test(name);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isVariableName = (name: string): boolean => NAME.test(name);

// Claude Code strips its own credentials from the commands it runs when this is set.
const SCRUB = { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };

export function agentEnv(source: Readonly<Record<string, string | undefined>>, extra: readonly string[]): Record<string, string> {
    const allowed = new Set([...BASE_VARIABLES, ...extra.filter((name) => !isSecretName(name))]);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
        if (value === undefined) continue;
        if (allowed.has(name) || LOCALE.test(name) || name === CLAUDE_AUTH_VARIABLE) env[name] = value;
    }
    return { ...env, ...SCRUB };
}
