export const CLAUDE_AUTH_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';

const BASE_VARIABLES = ['PATH', 'HOME', 'TERM', 'TZ', 'LANG', 'LANGUAGE', 'CI'];

const LOCALE = /^LC_[A-Z]+$/;

// The agent session's environment: the runner's own values for a short allowlist, and the Claude token. GitHub, the
// action inputs and every service the job talks to put credentials in the rest, so none of it reaches the session.
export function agentEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
    const allowed = new Set([...BASE_VARIABLES, CLAUDE_AUTH_VARIABLE]);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
        if (value !== undefined && (allowed.has(name) || LOCALE.test(name))) env[name] = value;
    }
    return env;
}
