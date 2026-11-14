import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionLimitError, type AgentRun, type RunAgent } from '../review/agent.ts';
import type { RepoRules } from '../review/prompts.ts';
import {
    FIXER_BUDGET_USD,
    FIXER_MAX_TURNS,
    FIXER_MODEL,
    FixOutput,
    fixerPrompt,
    fixerSystemPrompt,
    fixerTools,
    gate,
    leakedIn,
} from './fix.ts';
import { collectChanges, gitIn, snapshot, tamperedPaths, type Git } from './git.ts';
import type { FixResult, PlannedIssue } from './handoff.ts';

async function readRules(cwd: string): Promise<RepoRules> {
    const read = (name: string) => readFile(join(cwd, name), 'utf8').catch(() => undefined);
    const [claudeMd, reviewMd] = await Promise.all([read('CLAUDE.md'), read('REVIEW.md')]);
    return { ...(claudeMd === undefined ? {} : { claudeMd }), ...(reviewMd === undefined ? {} : { reviewMd }) };
}

export type FixerOptions = {
    planned: PlannedIssue;
    cwd: string;
    runAgent: RunAgent;
    // The agent session's environment, already reduced to an allowlist.
    env: Readonly<Record<string, string>>;
    secrets: () => readonly string[];
    git?: Git;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runFixer(options: FixerOptions): Promise<FixResult> {
    const { planned, cwd } = options;
    const git = options.git ?? gitIn(cwd);
    const head = git(['rev-parse', 'HEAD']).trim();
    if (head !== planned.sha) return { status: 'failed', error: `the checkout is at ${head}, but the plan was made at ${planned.sha}` };
    const before = await snapshot(git, cwd);

    let run: AgentRun<FixOutput>;
    try {
        run = await options.runAgent({
            model: FIXER_MODEL,
            systemPrompt: fixerSystemPrompt(planned.project, await readRules(cwd)),
            prompt: fixerPrompt(planned.context),
            schema: FixOutput,
            cwd,
            effort: 'high',
            maxTurns: FIXER_MAX_TURNS,
            maxBudgetUsd: FIXER_BUDGET_USD,
            env: options.env,
            ...fixerTools(planned.project),
        });
    } catch (error) {
        if (error instanceof SessionLimitError) return { status: 'exhausted', reason: `The fixer ran out of budget or turns before it found a fix: ${error.message}` };
        return { status: 'failed', error: errorText(error) };
    }

    const tampered = await tamperedPaths(cwd, before);
    if (tampered.length > 0) {
        return { status: 'failed', error: `the fixer's run changed ${tampered.map((path) => `\`${path}\``).join(', ')}, which git on the runner reads, so nothing was collected` };
    }
    const changes = await collectChanges(git, cwd, before, planned.project.roots);
    const texts = changes.flatMap((change) => (change.content === null ? [] : [{ path: change.path, text: Buffer.from(change.content, 'base64').toString('utf8') }]));
    const verdict = gate({ output: run.output, changes, project: planned.project, leaks: leakedIn(texts, options.secrets()) });
    const { billing, costUsd, turns, durationMs, denied } = run.stats;
    return { status: 'done', output: run.output, gate: verdict, changes, stats: { billing, costUsd, turns, durationMs, denied } };
}
