import type { ChangedFile, PullRequest } from '../risk/pull-request.ts';
import type { Tier } from '../risk/tier.ts';
import type { AgentStats, RunAgent } from './agent.ts';
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

export type AgentReport = AgentStats & { role: string };

export type ReviewResult = {
    tier: Tier;
    findings: ReviewedFinding[];
    candidates: number;
    agents: AgentReport[];
    costUsd: number;
    durationMs: number;
};

export const MAX_CONCURRENT_AGENTS = 4;

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
    const record =
        (role: string) =>
        <T extends { stats: AgentStats }>(run: T): T => {
            agents.push({ role, ...run.stats });
            return run;
        };

    const finderRuns = await Promise.all(
        findersFor(input.tier).map((spec) =>
            limit(async () => {
                const role = `finder: ${spec.kinds.join(', ')}`;
                const request = {
                    model: spec.model,
                    systemPrompt: finderSystemPrompt(spec.kinds, input.rules),
                    prompt: finderPrompt(input.pr, input.files, input.scope),
                    schema: FinderOutput,
                    cwd: input.cwd,
                    effort: 'high' as const,
                    maxTurns: 60,
                    maxBudgetUsd: 8,
                };
                const first = record(role)(await runAgent(request));
                if ((first.stats.tools['Read'] ?? 0) > 0) return [first];
                const retry = record(`${role} (retry)`)(
                    await runAgent({ ...request, prompt: `${request.prompt}\n\n${FINDER_RETRY_NOTE}` }),
                );
                return [first, retry];
            }),
        ),
    );
    const nearby = dedupe(finderRuns.flat().flatMap((run) => run.output.candidates));
    const candidates =
        nearby.length < 2
            ? nearby
            : mergeDuplicates(
                  nearby,
                  record('merger')(
                      await runAgent({
                          model: MERGER_MODEL,
                          systemPrompt: MERGER_SYSTEM_PROMPT,
                          prompt: mergerPrompt(nearby),
                          schema: DuplicateGroups,
                          cwd: input.cwd,
                          effort: 'medium',
                          maxTurns: 5,
                          maxBudgetUsd: 1,
                      }),
                  ).output,
              );

    const reviewed = await Promise.all(
        candidates.map(async (candidate): Promise<ReviewedFinding> => {
            const verdicts = await Promise.all(
                Array.from({ length: VERIFIERS_PER_CANDIDATE }, () =>
                    limit(() =>
                        runAgent({
                            model: VERIFIER_MODEL,
                            systemPrompt: verifierSystemPrompt(input.rules),
                            prompt: verifierPrompt(input.pr, input.files, candidate),
                            schema: Verdict,
                            cwd: input.cwd,
                            effort: 'medium',
                            maxTurns: 25,
                            maxBudgetUsd: 1,
                        }).then(record(`reviewer: ${candidate.file}:${candidate.line}`)),
                    ),
                ),
            );
            const votes = verdicts.map((run) => run.output);
            return { ...candidate, verdicts: votes, placement: placement(votes) };
        }),
    );

    return {
        tier: input.tier,
        findings: capSummaryFindings(reviewed),
        candidates: candidates.length,
        agents,
        costUsd: agents.reduce((sum, agent) => sum + agent.costUsd, 0),
        durationMs: Date.now() - started,
    };
}
