export const CLAUDE_AUTH_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';

// Only variables that mean the same inside the fixer's container. PATH, HOME and the toolchain roots describe the
// runner's file system, so the image sets its own.
const BASE_VARIABLES = ['TERM', 'TZ', 'LANG', 'LANGUAGE', 'CI', 'DOTNET_NOLOGO', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE'];

const IMAGE_VARIABLES = new Set(['PATH', 'HOME']);

const LOCALE = /^LC_[A-Z]+$/;

// GitHub, the runner, the action inputs and every service the job talks to put credentials in these.
const SECRET = /TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|_KEY$|^KEY$|^ACTIONS_|^GITHUB_|^RUNNER_|^INPUT_|^SENTRY_|^TYPESAFE_|^ANTHROPIC_|^GH_|^NUGET_AUTH|^NPM_CONFIG_/i;

export const isSecretName = (name: string): boolean => SECRET.test(name);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isVariableName = (name: string): boolean => NAME.test(name);

export type ContainerAuth = 'claude' | 'none';

// The environment of a fixer container, as names and the runner's values for them. The values reach Docker through
// the environment of the docker command, never its arguments.
export function containerEnv(source: Readonly<Record<string, string | undefined>>, extra: readonly string[], auth: ContainerAuth): Record<string, string> {
    const allowed = new Set([...BASE_VARIABLES, ...extra.filter((name) => !isSecretName(name) && !IMAGE_VARIABLES.has(name))]);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
        if (value === undefined) continue;
        if (allowed.has(name) || LOCALE.test(name) || (auth === 'claude' && name === CLAUDE_AUTH_VARIABLE)) env[name] = value;
    }
    return env;
}

const DOCKER_CLIENT = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];

// The docker command itself needs only what finds the daemon, plus the container's variables to pass by name.
export function dockerClientEnv(source: Readonly<Record<string, string | undefined>>, container: Readonly<Record<string, string>>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of DOCKER_CLIENT) {
        const value = source[name];
        if (value !== undefined) env[name] = value;
    }
    return { ...env, ...container };
}
