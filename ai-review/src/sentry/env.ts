export const CLAUDE_AUTH_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';

const BASE_VARIABLES = ['PATH', 'HOME', 'TERM', 'TZ', 'LANG', 'LANGUAGE', 'CI'];

const LOCALE = /^LC_[A-Z]+$/;

export function agentEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
    const allowed = new Set([...BASE_VARIABLES, CLAUDE_AUTH_VARIABLE]);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
        if (value !== undefined && (allowed.has(name) || LOCALE.test(name))) env[name] = value;
    }
    return env;
}
