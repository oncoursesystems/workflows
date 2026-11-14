import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoRules } from '../review/prompts.ts';
import {
    FIXER_BUDGET_USD,
    FIXER_MAX_TURNS,
    FIXER_MODEL,
    fixerPrompt,
    fixerSystemPrompt,
    fixerTools,
    gate,
    leakedIn,
} from './fix.ts';
import { collectChanges, gitIn, snapshot, tamperedPaths, type Git } from './git.ts';
import type { CommandRun, FixResult, PlannedIssue } from './handoff.ts';
import type { SessionRequest, SessionResult } from './session.ts';

async function readRules(cwd: string): Promise<RepoRules> {
    const read = (name: string) => readFile(join(cwd, name), 'utf8').catch(() => undefined);
    const [claudeMd, reviewMd] = await Promise.all([read('CLAUDE.md'), read('REVIEW.md')]);
    return { ...(claudeMd === undefined ? {} : { claudeMd }), ...(reviewMd === undefined ? {} : { reviewMd }) };
}

export type Containers = {
    // Runs the agent session in a throwaway container with the checkout mounted.
    session(request: SessionRequest): Promise<SessionResult>;
    // Runs each project command once in a fresh container, after the session.
    verify(commands: readonly string[]): Promise<CommandRun[]>;
};

export type FixerOptions = {
    planned: PlannedIssue;
    cwd: string;
    containers: Containers;
    secrets: () => readonly string[];
    git?: Git;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function sessionRequest(planned: PlannedIssue, cwd: string): Promise<SessionRequest> {
    return {
        model: FIXER_MODEL,
        systemPrompt: fixerSystemPrompt(planned.project, await readRules(cwd)),
        prompt: fixerPrompt(planned.context),
        effort: 'high',
        maxTurns: FIXER_MAX_TURNS,
        maxBudgetUsd: FIXER_BUDGET_USD,
        ...fixerTools(planned.project),
    };
}

export async function runFixer(options: FixerOptions): Promise<FixResult> {
    const { planned, cwd } = options;
    const git = options.git ?? gitIn(cwd);
    const head = git(['rev-parse', 'HEAD']).trim();
    if (head !== planned.sha) return { status: 'failed', error: `the checkout is at ${head}, but the plan was made at ${planned.sha}` };
    const before = await snapshot(git, cwd);

    let session: SessionResult;
    try {
        session = await options.containers.session(await sessionRequest(planned, cwd));
    } catch (error) {
        return { status: 'failed', error: `the session container failed: ${errorText(error)}` };
    }
    if (session.status === 'exhausted') return { status: 'exhausted', reason: `The fixer ran out of budget or turns before it found a fix: ${session.error}` };
    if (session.status !== 'done') return { status: 'failed', error: session.error };

    let verification: CommandRun[] = [];
    if (session.output.outcome === 'fixed') {
        try {
            verification = await options.containers.verify(planned.project.commands);
        } catch (error) {
            return { status: 'failed', error: `the verification container failed: ${errorText(error)}` };
        }
    }

    const tampered = await tamperedPaths(cwd, before);
    if (tampered.length > 0) {
        return { status: 'failed', error: `the fixer's run changed ${tampered.map((path) => `\`${path}\``).join(', ')}, which git on the runner reads, so nothing was collected` };
    }
    const changes = await collectChanges(git, cwd, before, planned.project.roots);
    const texts = changes.flatMap((change) => (change.content === null ? [] : [{ path: change.path, text: Buffer.from(change.content, 'base64').toString('utf8') }]));
    const verdict = gate({ output: session.output, verification, changes, project: planned.project, leaks: leakedIn(texts, options.secrets()) });
    return { status: 'done', output: session.output, verification, gate: verdict, changes, stats: session.stats };
}
