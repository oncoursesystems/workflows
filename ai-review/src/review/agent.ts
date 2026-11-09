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

export type Billing = 'subscription' | 'api';

export type AgentStats = {
    model: string;
    billing: Billing;
    costUsd: number;
    turns: number;
    durationMs: number;
    tools: Record<string, number>;
    denied: string[];
};

export type AgentRun<T> = { output: T; stats: AgentStats };

export type RunAgent = <T>(request: AgentRequest<T>) => Promise<AgentRun<T>>;

const TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git blame:*)', 'Bash(git show:*)', 'Bash(git diff:*)'];

export function outputSchema(schema: z.ZodType): Record<string, unknown> {
    const { $schema: _dialect, ...rest } = z.toJSONSchema(schema);
    return rest;
}

export class UsageLimitError extends Error {
    override name = 'UsageLimitError';
}

const deniedCall = ({ tool_name, tool_input }: { tool_name: string; tool_input: Record<string, unknown> }): string =>
    typeof tool_input['command'] === 'string' ? `${tool_name}(${tool_input['command']})` : tool_name;

type Auth = { billing: 'subscription' } | { billing: 'api'; token: string };

const sessionEnv = (auth: Auth) =>
    auth.billing === 'subscription'
        ? { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined }
        : { ...process.env, ANTHROPIC_AUTH_TOKEN: auth.token, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined };

export const runAgent: RunAgent = (request) => runSession(request, { billing: 'subscription' });

export type ApiFallback = { apiToken: () => Promise<string>; apiOnly: boolean };

export function runAgentWithApiFallback({ apiToken, apiOnly }: ApiFallback): RunAgent {
    let onApi = apiOnly;
    let token: Promise<string> | undefined;
    return async <T>(request: AgentRequest<T>): Promise<AgentRun<T>> => {
        if (!onApi) {
            try {
                return await runSession(request, { billing: 'subscription' });
            } catch (error) {
                if (!(error instanceof UsageLimitError)) throw error;
                onApi = true;
            }
        }
        token ??= apiToken();
        return runSession(request, { billing: 'api', token: await token });
    };
}

async function runSession<T>(request: AgentRequest<T>, auth: Auth): Promise<AgentRun<T>> {
    const started = Date.now();
    const tools: Record<string, number> = {};
    const session = query({
        prompt: request.prompt,
        options: {
            env: sessionEnv(auth),
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
    let limit: string | undefined;
    for await (const message of session) {
        if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') {
            limit = message.rate_limit_info.rateLimitType ?? 'usage';
        }
        if (message.type === 'assistant') {
            for (const block of message.message.content) {
                if (block.type === 'tool_use') tools[block.name] = (tools[block.name] ?? 0) + 1;
            }
        }
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') {
            throw new Error(`${request.model} stopped with ${message.subtype}: ${message.errors.join('; ')}`);
        }
        if (limit !== undefined) throw new UsageLimitError(`Claude hit its ${limit} limit: ${message.result}`);
        if (message.is_error) throw new Error(`${request.model} stopped with an error: ${message.result}`);
        const parsed = request.schema.safeParse(message.structured_output);
        if (!parsed.success) throw new Error(`${request.model} returned output that does not match the schema: ${parsed.error.message}`);
        return {
            output: parsed.data,
            stats: {
                model: request.model,
                billing: auth.billing,
                costUsd: message.total_cost_usd,
                turns: message.num_turns,
                durationMs: Date.now() - started,
                tools,
                denied: message.permission_denials.map(deniedCall),
            },
        };
    }
    throw new Error(`${request.model} ended without a result`);
}
