import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

let messages: unknown[] = [];
let sessions: unknown[][] = [];
let envs: Array<Record<string, string | undefined>> = [];
let toolOptions: Array<{ tools: string[]; allowedTools: string[] }> = [];

type Options = { env: Record<string, string | undefined>; tools: string[]; allowedTools: string[] };

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: ({ options }: { options: Options }) => {
        envs.push(options.env);
        toolOptions.push({ tools: options.tools, allowedTools: options.allowedTools });
        const session = sessions.shift() ?? messages;
        return (async function* () {
            yield* session;
        })();
    },
}));

const { runAgent, runAgentWithApiFallback, SessionLimitError, UsageLimitError } = await import('./agent.ts');

const request = {
    model: 'claude-sonnet-5-5',
    systemPrompt: 's',
    prompt: 'p',
    schema: z.object({ ok: z.boolean() }),
    cwd: '.',
    effort: 'low' as const,
    maxTurns: 1,
    maxBudgetUsd: 1,
};

const result = (fields: Record<string, unknown>) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    num_turns: 1,
    total_cost_usd: 0.01,
    permission_denials: [],
    ...fields,
});

describe('runAgent', () => {
    beforeEach(() => {
        messages = [];
        sessions = [];
        envs = [];
    });

    it('returns the structured output', async () => {
        messages = [result({ structured_output: { ok: true } })];
        await expect(runAgent(request)).resolves.toMatchObject({ output: { ok: true } });
    });

    it('reports a usage limit with the message Claude Code gives, not as a schema mismatch', async () => {
        messages = [
            { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } },
            result({ is_error: true, result: "You've hit your limit · resets 9pm (UTC)" }),
        ];
        const failure = runAgent(request);
        await expect(failure).rejects.toBeInstanceOf(UsageLimitError);
        await expect(failure).rejects.toThrow("Claude hit its five_hour limit: You've hit your limit · resets 9pm (UTC)");
    });

    it.each(['error_max_turns', 'error_max_budget_usd'])('reports %s as a session limit', async (subtype) => {
        messages = [result({ subtype, errors: ['out'] })];
        const failure = runAgent(request);
        await expect(failure).rejects.toBeInstanceOf(SessionLimitError);
        await expect(failure).rejects.toThrow(`claude-sonnet-5-5 stopped with ${subtype}: out`);
    });

    it('reports another failed subtype as a plain error', async () => {
        messages = [result({ subtype: 'error_during_execution', errors: ['boom'] })];
        const failure = runAgent(request);
        await expect(failure).rejects.not.toBeInstanceOf(SessionLimitError);
        await expect(failure).rejects.toThrow('claude-sonnet-5-5 stopped with error_during_execution: boom');
    });

    it('reports any other error result with its message', async () => {
        messages = [result({ is_error: true, result: 'API Error: 529 overloaded' })];
        await expect(runAgent(request)).rejects.toThrow('claude-sonnet-5-5 stopped with an error: API Error: 529 overloaded');
    });

    it('keeps the read-only review tools and the process env when the request names none', async () => {
        process.env['SENTRY_FIX_TEST_VAR'] = 'present';
        toolOptions = [];
        messages = [result({ structured_output: { ok: true } })];
        await runAgent(request);
        expect(toolOptions[0]).toEqual({
            tools: ['Read', 'Grep', 'Glob', 'Bash'],
            allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git blame:*)', 'Bash(git show:*)', 'Bash(git diff:*)'],
        });
        expect(envs[0]?.['SENTRY_FIX_TEST_VAR']).toBe('present');
        delete process.env['SENTRY_FIX_TEST_VAR'];
    });

    it('runs with the tools and the env the request gives, and nothing else from the process env', async () => {
        process.env['GITHUB_TOKEN'] = 'ghs_secret';
        toolOptions = [];
        messages = [result({ structured_output: { ok: true } })];
        await runAgent({ ...request, tools: ['Read', 'Edit'], allowedTools: ['Read', 'Edit(src/**)'], env: { PATH: '/bin' } });
        expect(toolOptions[0]).toEqual({ tools: ['Read', 'Edit'], allowedTools: ['Read', 'Edit(src/**)'] });
        expect(envs[0]?.['PATH']).toBe('/bin');
        expect(envs[0]).not.toHaveProperty('GITHUB_TOKEN');
        delete process.env['GITHUB_TOKEN'];
    });

    it('ignores a rate limit warning that did not stop the run', async () => {
        messages = [
            { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' } },
            result({ structured_output: { ok: true } }),
        ];
        await expect(runAgent(request)).resolves.toMatchObject({ output: { ok: true } });
    });
});

describe('runAgentWithApiFallback', () => {
    const limited = [
        { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } },
        result({ is_error: true, result: "You've hit your limit" }),
    ];
    const answered = result({ structured_output: { ok: true } });

    beforeEach(() => {
        messages = [];
        sessions = [];
        envs = [];
        process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'oauth';
        process.env['ANTHROPIC_API_KEY'] = 'stray-runner-key';
    });

    const fallback = (apiOnly = false) => {
        let exchanges = 0;
        const runner = runAgentWithApiFallback({
            apiOnly,
            apiToken: async () => {
                exchanges++;
                return 'sk-ant-oat01-minted';
            },
        });
        return { runner, exchanges: () => exchanges };
    };

    it('runs on the subscription while it has room, and never exchanges a token', async () => {
        sessions = [[answered]];
        const { runner, exchanges } = fallback();
        const run = await runner(request);
        expect(run.stats.billing).toBe('subscription');
        expect(envs[0]?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth');
        expect(envs[0]?.['ANTHROPIC_API_KEY']).toBeUndefined();
        expect(envs[0]?.['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
        expect(exchanges()).toBe(0);
    });

    it('reruns the agent on the API after a usage limit, exchanges once, and keeps the rest of the run there', async () => {
        sessions = [limited, [answered], [answered]];
        const { runner, exchanges } = fallback();
        const first = await runner(request);
        const second = await runner(request);
        expect([first.stats.billing, second.stats.billing]).toEqual(['api', 'api']);
        expect(envs).toHaveLength(3);
        expect(envs[1]?.['ANTHROPIC_AUTH_TOKEN']).toBe('sk-ant-oat01-minted');
        expect(envs[1]?.['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
        expect(envs[1]?.['ANTHROPIC_API_KEY']).toBeUndefined();
        expect(envs[2]?.['ANTHROPIC_AUTH_TOKEN']).toBe('sk-ant-oat01-minted');
        expect(exchanges()).toBe(1);
    });

    it('goes straight to the API when the run asks for it', async () => {
        sessions = [[answered]];
        const { runner } = fallback(true);
        expect((await runner(request)).stats.billing).toBe('api');
        expect(envs).toHaveLength(1);
    });

    it('does not switch to the API for any other error', async () => {
        sessions = [[result({ is_error: true, result: 'API Error: 529 overloaded' })]];
        const { runner, exchanges } = fallback();
        await expect(runner(request)).rejects.toThrow('529 overloaded');
        expect(envs).toHaveLength(1);
        expect(exchanges()).toBe(0);
    });
});
