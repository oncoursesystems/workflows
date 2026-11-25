import type { ChangedFile, PullRequest } from '../github/pull-request.ts';
import type { Tier } from '../risk/tier.ts';
import { AgentError, SessionLimitError, type AgentRequest, type AgentRun, type AgentStats, type RunAgent, type SessionLimit } from './agent.ts';
import {
    capSummaryFindings,
    dedupe,
    DuplicateGroups,
    FinderOutput,
    mergeDuplicates,
    placement,
    Verdict,
    VERIFIERS_PER_CANDIDATE,
    type ReviewedFinding,
} from './finding.ts';
import { findersFor, MERGER_MODEL, VERIFIER_MODEL } from './plan.ts';
import {
    FINDER_RETRY_NOTE,
    finderPrompt,
    finderSystemPrompt,
    MERGER_SYSTEM_PROMPT,
    mergerPrompt,
    verifierPrompt,
    verifierSystemPrompt,
    type RepoRules,
} from './prompts.ts';

export type ReviewInput = {
    pr: PullRequest;
    tier: Tier;
    files: ChangedFile[];
    scope: string;
    rules: RepoRules;
    cwd: string;
};

export type AgentReport = AgentStats & { role: string; limit?: SessionLimit };

export type ReviewResult = {
    tier: Tier;
    findings: ReviewedFinding[];
    candidates: number;
    agents: AgentReport[];
    costUsd: number;
    durationMs: number;
};

export const MAX_CONCURRENT_AGENTS = 4;

export const FINDER_MAX_TURNS = 60;

export class ReviewFailedError extends Error {
    override name = 'ReviewFailedError';
    readonly agents: AgentReport[];
    readonly durationMs: number;

    constructor(cause: unknown, agents: AgentReport[], durationMs: number) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.agents = agents;
        this.durationMs = durationMs;
    }
}

const lookedAtCode = (tools: Record<string, number>): boolean => Object.keys(tools).some((name) => name !== 'StructuredOutput');

const limiter = (limit: number) => {
    let running = 0;
    const waiting: Array<() => void> = [];
    return async <T>(task: () => Promise<T>): Promise<T> => {
        if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
        running++;
        try {
            return await task();
        } finally {
            running--;
            waiting.shift()?.();
        }
    };
};

export async function review(input: ReviewInput, runAgent: RunAgent, concurrency = MAX_CONCURRENT_AGENTS): Promise<ReviewResult> {
    const started = Date.now();
    const limit = limiter(concurrency);
    const agents: AgentReport[] = [];
    const stop = new AbortController();
    let failure: { error: unknown } | undefined;

    const attempt = <T>(role: string, request: AgentRequest<T>): Promise<AgentRun<T> | undefined> =>
        limit(async () => {
            if (stop.signal.aborted) return undefined;
            try {
                const run = await runAgent({ ...request, signal: stop.signal });
                agents.push({ role, ...run.stats });
                return run;
            } catch (error) {
                if (error instanceof SessionLimitError) {
                    agents.push({ role, ...error.stats, limit: error.limit });
                    return undefined;
                }
                if (error instanceof AgentError) agents.push({ role, ...error.stats });
                if (failure === undefined) {
                    failure = { error };
                    stop.abort();
                }
                return undefined;
            }
        });
    const throwIfFailed = () => {
        if (failure !== undefined) throw new ReviewFailedError(failure.error, agents, Date.now() - started);
    };

    const finderRuns = await Promise.all(
        findersFor(input.tier).map(async (spec) => {
            const role = `finder: ${spec.kinds.join(', ')}`;
            const request = {
                model: spec.model,
                systemPrompt: finderSystemPrompt(spec.kinds, input.rules),
                prompt: finderPrompt(input.pr, input.files, input.scope),
                schema: FinderOutput,
                cwd: input.cwd,
                effort: 'high' as const,
                maxTurns: FINDER_MAX_TURNS,
                maxBudgetUsd: 8,
            };
            const first = await attempt(role, request);
            if (first === undefined) return [];
            if (lookedAtCode(first.stats.tools)) return [first];
            const retry = await attempt(`${role} (retry)`, { ...request, prompt: `${request.prompt}\n\n${FINDER_RETRY_NOTE}` });
            return retry === undefined ? [first] : [first, retry];
        }),
    );
    throwIfFailed();

    const nearby = dedupe(finderRuns.flat().flatMap((run) => run.output.candidates));
    const merger =
        nearby.length < 2
            ? undefined
            : await attempt('merger', {
                  model: MERGER_MODEL,
                  systemPrompt: MERGER_SYSTEM_PROMPT,
                  prompt: mergerPrompt(nearby),
                  schema: DuplicateGroups,
                  cwd: input.cwd,
                  effort: 'medium',
                  maxTurns: 5,
                  maxBudgetUsd: 1,
              });
    throwIfFailed();
    const candidates = merger === undefined ? nearby : mergeDuplicates(nearby, merger.output);

    const reviewed = await Promise.all(
        candidates.map(async (candidate): Promise<ReviewedFinding> => {
            const verdicts = await Promise.all(
                Array.from({ length: VERIFIERS_PER_CANDIDATE }, () =>
                    attempt(`reviewer: ${candidate.file}:${candidate.line}`, {
                        model: VERIFIER_MODEL,
                        systemPrompt: verifierSystemPrompt(input.rules),
                        prompt: verifierPrompt(input.pr, input.files, candidate),
                        schema: Verdict,
                        cwd: input.cwd,
                        effort: 'medium',
                        maxTurns: 25,
                        maxBudgetUsd: 1,
                    }),
                ),
            );
            const votes = verdicts.flatMap((run) => (run === undefined ? [] : [run.output]));
            return { ...candidate, verdicts: votes, placement: placement(votes) };
        }),
    );
    throwIfFailed();

    return {
        tier: input.tier,
        findings: capSummaryFindings(reviewed),
        candidates: candidates.length,
        agents,
        costUsd: agents.reduce((sum, agent) => sum + agent.costUsd, 0),
        durationMs: Date.now() - started,
    };
}
