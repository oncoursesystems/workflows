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
    tools?: readonly string[];
    allowedTools?: readonly string[];
    env?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
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

export class AgentError extends Error {
    override name = 'AgentError';
    readonly stats: AgentStats;

    constructor(message: string, stats: AgentStats) {
        super(message);
        this.stats = stats;
    }
}

export type SessionLimit = 'turns' | 'budget';

export class SessionLimitError extends AgentError {
    override name = 'SessionLimitError';

    readonly limit: SessionLimit;

    constructor(message: string, stats: AgentStats, limit: SessionLimit) {
        super(message, stats);
        this.limit = limit;
    }
}

const SESSION_LIMITS: Readonly<Record<string, SessionLimit>> = { error_max_turns: 'turns', error_max_budget_usd: 'budget' };

const deniedCall = ({ tool_name, tool_input }: { tool_name: string; tool_input: Record<string, unknown> }): string =>
    typeof tool_input['command'] === 'string' ? `${tool_name}(${tool_input['command']})` : tool_name;

type Auth = { billing: 'subscription' } | { billing: 'api'; token: string };

const sessionEnv = (auth: Auth, base: Readonly<Record<string, string | undefined>>) =>
    auth.billing === 'subscription'
        ? { ...base, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined }
        : { ...base, ANTHROPIC_AUTH_TOKEN: auth.token, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined };

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
    const abortController = new AbortController();
    const stop = () => abortController.abort();
    if (request.signal?.aborted) stop();
    request.signal?.addEventListener('abort', stop, { once: true });
    try {
        return await readSession(request, auth, abortController);
    } finally {
        request.signal?.removeEventListener('abort', stop);
    }
}

async function readSession<T>(request: AgentRequest<T>, auth: Auth, abortController: AbortController): Promise<AgentRun<T>> {
    const started = Date.now();
    const tools: Record<string, number> = {};
    const session = query({
        prompt: request.prompt,
        options: {
            env: sessionEnv(auth, request.env ?? process.env),
            model: request.model,
            systemPrompt: request.systemPrompt,
            cwd: request.cwd,
            tools: [...(request.tools ?? TOOLS)],
            allowedTools: [...(request.allowedTools ?? ALLOWED_TOOLS)],
            permissionMode: 'dontAsk',
            settingSources: [],
            persistSession: false,
            effort: request.effort,
            maxTurns: request.maxTurns,
            maxBudgetUsd: request.maxBudgetUsd,
            outputFormat: { type: 'json_schema', schema: outputSchema(request.schema) },
            abortController,
        },
    });
    let rateLimit: string | undefined;
    for await (const message of session) {
        if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') {
            rateLimit = message.rate_limit_info.rateLimitType ?? 'usage';
        }
        if (message.type === 'assistant') {
            for (const block of message.message.content) {
                if (block.type === 'tool_use') tools[block.name] = (tools[block.name] ?? 0) + 1;
            }
        }
        if (message.type !== 'result') continue;
        const stats: AgentStats = {
            model: request.model,
            billing: auth.billing,
            costUsd: message.total_cost_usd,
            turns: message.num_turns,
            durationMs: Date.now() - started,
            tools,
            denied: message.permission_denials.map(deniedCall),
        };
        if (message.subtype !== 'success') {
            const text = `${request.model} stopped with ${message.subtype}: ${message.errors.join('; ')}`;
            const limit = SESSION_LIMITS[message.subtype];
            throw limit === undefined ? new AgentError(text, stats) : new SessionLimitError(text, stats, limit);
        }
        if (rateLimit !== undefined) throw new UsageLimitError(`Claude hit its ${rateLimit} limit: ${message.result}`);
        if (message.is_error) throw new AgentError(`${request.model} stopped with an error: ${message.result}`, stats);
        const parsed = request.schema.safeParse(message.structured_output);
        if (!parsed.success) {
            throw new AgentError(`${request.model} returned output that does not match the schema: ${parsed.error.message}`, stats);
        }
        return { output: parsed.data, stats };
    }
    throw new Error(`${request.model} ended without a result`);
}
