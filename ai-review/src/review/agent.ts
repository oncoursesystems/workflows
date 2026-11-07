import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export type AgentRequest<T> = {
    model: string;
    systemPrompt: string;
    prompt: string;
    schema: z.ZodType<T>;
    cwd: string;
    effort: 'low' | 'medium' | 'high';
    maxTurns: number;
    maxBudgetUsd: number;
};

export type AgentRun<T> = { output: T; costUsd: number; turns: number };

export type RunAgent = <T>(request: AgentRequest<T>) => Promise<AgentRun<T>>;

const TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git blame:*)', 'Bash(git show:*)', 'Bash(git diff:*)'];

export function outputSchema(schema: z.ZodType): Record<string, unknown> {
    const { $schema: _dialect, ...rest } = z.toJSONSchema(schema);
    return rest;
}

export const runAgent: RunAgent = async <T>(request: AgentRequest<T>): Promise<AgentRun<T>> => {
    const session = query({
        prompt: request.prompt,
        options: {
            model: request.model,
            systemPrompt: request.systemPrompt,
            cwd: request.cwd,
            tools: TOOLS,
            allowedTools: ALLOWED_TOOLS,
            permissionMode: 'dontAsk',
            settingSources: [],
            persistSession: false,
            effort: request.effort,
            maxTurns: request.maxTurns,
            maxBudgetUsd: request.maxBudgetUsd,
            outputFormat: { type: 'json_schema', schema: outputSchema(request.schema) },
        },
    });
    for await (const message of session) {
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') {
            throw new Error(`${request.model} stopped with ${message.subtype}: ${message.errors.join('; ')}`);
        }
        const parsed = request.schema.safeParse(message.structured_output);
        if (!parsed.success) throw new Error(`${request.model} returned output that does not match the schema: ${parsed.error.message}`);
        return { output: parsed.data, costUsd: message.total_cost_usd, turns: message.num_turns };
    }
    throw new Error(`${request.model} ended without a result`);
};
