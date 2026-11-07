import type { ChangedFile, PullRequest } from '../risk/pull-request.ts';
import type { Tier } from '../risk/tier.ts';
import type { RunAgent } from './agent.ts';
import {
    capSummaryFindings,
    dedupe,
    FinderOutput,
    placement,
    Verdict,
    VERIFIERS_PER_CANDIDATE,
    type ReviewedFinding,
} from './finding.ts';
import { findersFor, VERIFIER_MODEL } from './plan.ts';
import { finderPrompt, finderSystemPrompt, verifierPrompt, verifierSystemPrompt, type RepoRules } from './prompts.ts';

export type ReviewInput = {
    pr: PullRequest;
    tier: Tier;
    files: ChangedFile[];
    scope: string;
    rules: RepoRules;
    cwd: string;
};

export type ReviewResult = {
    tier: Tier;
    findings: ReviewedFinding[];
    candidates: number;
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
    let costUsd = 0;
    const spend = <T extends { costUsd: number }>(run: T): T => {
        costUsd += run.costUsd;
        return run;
    };

    const finderRuns = await Promise.all(
        findersFor(input.tier).map((spec) =>
            limit(() =>
                runAgent({
                    model: spec.model,
                    systemPrompt: finderSystemPrompt(spec.kinds, input.rules),
                    prompt: finderPrompt(input.pr, input.files, input.scope),
                    schema: FinderOutput,
                    cwd: input.cwd,
                    effort: 'high',
                    maxTurns: 60,
                    maxBudgetUsd: 8,
                }).then(spend),
            ),
        ),
    );
    const candidates = dedupe(finderRuns.flatMap((run) => run.output.candidates));

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
                        }).then(spend),
                    ),
                ),
            );
            const votes = verdicts.map((run) => run.output);
            return { ...candidate, verdicts: votes, placement: placement(candidate, votes) };
        }),
    );

    return {
        tier: input.tier,
        findings: capSummaryFindings(reviewed),
        candidates: candidates.length,
        costUsd,
        durationMs: Date.now() - started,
    };
}
