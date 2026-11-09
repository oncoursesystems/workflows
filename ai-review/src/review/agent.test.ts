import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

let messages: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: () =>
        (async function* () {
            yield* messages;
        })(),
}));

const { runAgent, UsageLimitError } = await import('./agent.ts');

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

    it('reports any other error result with its message', async () => {
        messages = [result({ is_error: true, result: 'API Error: 529 overloaded' })];
        await expect(runAgent(request)).rejects.toThrow('claude-sonnet-5-5 stopped with an error: API Error: 529 overloaded');
    });

    it('ignores a rate limit warning that did not stop the run', async () => {
        messages = [
            { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' } },
            result({ structured_output: { ok: true } }),
        ];
        await expect(runAgent(request)).resolves.toMatchObject({ output: { ok: true } });
    });
});
