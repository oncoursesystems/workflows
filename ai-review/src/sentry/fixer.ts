import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoRules } from '../review/prompts.ts';
import type { RunAgent } from '../review/agent.ts';
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
    type Change,
} from './fix.ts';
import type { ChangedFile, FixResult, PlannedIssue } from './handoff.ts';

export type Git = (args: readonly string[]) => string;

// The fixer can change files that git reads, so hooks and fsmonitor stay off for every git call after it.
export const gitIn =
    (cwd: string): Git =>
    (args) =>
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
            cwd,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        });

// A symlink could point at /proc or the runner's home, so only regular files are read.
const REGULAR_FILE = new Set(['100644', '100755']);

const STATUS: Record<string, Change['status']> = { A: 'added', M: 'modified', T: 'modified', D: 'deleted' };

export function parseRawDiff(raw: string): Change[] {
    const parts = raw.split('\0').filter((part) => part !== '');
    const changes: Change[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const [, newMode = '', , , letter = ''] = parts[i]!.replace(/^:/, '').split(' ');
        const status = STATUS[letter];
        if (status === undefined) throw new Error(`unexpected git status ${letter} for ${parts[i + 1]}`);
        changes.push({ path: parts[i + 1]!, status, mode: newMode });
    }
    return changes;
}

async function readRules(cwd: string): Promise<RepoRules> {
    const read = (name: string) => readFile(join(cwd, name), 'utf8').catch(() => undefined);
    const [claudeMd, reviewMd] = await Promise.all([read('CLAUDE.md'), read('REVIEW.md')]);
    return { ...(claudeMd === undefined ? {} : { claudeMd }), ...(reviewMd === undefined ? {} : { reviewMd }) };
}

export async function collectChanges(git: Git, cwd: string, base: string): Promise<ChangedFile[]> {
    git(['add', '--all']);
    const changes = parseRawDiff(git(['diff', '--cached', '--raw', '-z', '--no-renames', base]));
    return Promise.all(
        changes.map(async (change) => ({
            ...change,
            content: REGULAR_FILE.has(change.mode) ? (await readFile(join(cwd, change.path))).toString('base64') : null,
        })),
    );
}

export type FixerOptions = {
    planned: PlannedIssue;
    cwd: string;
    runAgent: RunAgent;
    env: Record<string, string>;
    secrets: () => readonly string[];
    git?: Git;
};

export async function runFixer(options: FixerOptions): Promise<FixResult> {
    const { planned, cwd } = options;
    const git = options.git ?? gitIn(cwd);
    const head = git(['rev-parse', 'HEAD']).trim();
    if (head !== planned.sha) throw new Error(`the checkout is at ${head}, but the plan was made at ${planned.sha}`);

    let run;
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
            ...fixerTools(planned.project),
            env: options.env,
        });
    } catch (error) {
        return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }

    const changes = await collectChanges(git, cwd, planned.sha);
    const texts = changes.flatMap((change) => (change.content === null ? [] : [{ path: change.path, text: Buffer.from(change.content, 'base64').toString('utf8') }]));
    const verdict = gate({ output: run.output, changes, project: planned.project, leaks: leakedIn(texts, options.secrets()) });
    const { billing, costUsd, turns, durationMs, denied } = run.stats;
    return { status: 'done', output: run.output, gate: verdict, changes, stats: { billing, costUsd, turns, durationMs, denied } };
}
