import { z } from 'zod';
import { SessionLimitError, UsageLimitError } from '../review/agent.ts';
import { FixOutput } from './fix.ts';
import { FixStatsData } from './handoff.ts';

// The runner and the container's entry point, inner.ts, talk through these two files in the session directory.
export const REQUEST_FILE = 'request.json';
export const SESSION_FILE = 'session.json';

export const SessionRequest = z.object({
    model: z.string(),
    systemPrompt: z.string(),
    prompt: z.string(),
    effort: z.enum(['low', 'medium', 'high']),
    maxTurns: z.number().int().positive(),
    maxBudgetUsd: z.number().positive(),
    tools: z.array(z.string()),
    allowedTools: z.array(z.string()),
});

export type SessionRequest = z.infer<typeof SessionRequest>;

export const SessionResult = z.discriminatedUnion('status', [
    z.object({ status: z.literal('done'), output: FixOutput, stats: FixStatsData }),
    z.object({ status: z.literal('exhausted'), error: z.string() }),
    z.object({ status: z.literal('usage-limit'), error: z.string() }),
    z.object({ status: z.literal('error'), error: z.string() }),
]);

export type SessionResult = z.infer<typeof SessionResult>;

export function sessionFailure(error: unknown): SessionResult {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SessionLimitError) return { status: 'exhausted', error: message };
    if (error instanceof UsageLimitError) return { status: 'usage-limit', error: message };
    return { status: 'error', error: message };
}
