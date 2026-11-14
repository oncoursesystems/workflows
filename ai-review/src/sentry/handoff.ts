import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { describeIssues } from '../jev/response.ts';
import { PERIODS, type Period, type ProjectConfig } from './config.ts';
import type { IssueContext } from './context.ts';
import { FixOutput, type Change, type Gate } from './fix.ts';
import type { SentryIssue } from './sentry.ts';

// The jobs hand these to each other as JSON, so each side parses what it reads.

const SentryIssueData = z.object({
    id: z.string(),
    shortId: z.string(),
    title: z.string(),
    culprit: z.string(),
    permalink: z.string(),
    project: z.string(),
    count: z.number(),
    substatus: z.string().nullable(),
    level: z.string(),
}) satisfies z.ZodType<SentryIssue>;

const IssueContextData = z.object({
    issue: SentryIssueData,
    message: z.string(),
    frames: z.array(
        z.object({ file: z.string().nullable(), module: z.string().nullable(), fn: z.string().nullable(), line: z.number().nullable(), inApp: z.boolean() }),
    ),
    release: z.string().nullable(),
    platform: z.string(),
    transaction: z.string().nullable(),
}) satisfies z.ZodType<IssueContext>;

const ProjectData = z.object({
    slug: z.string(),
    description: z.string(),
    roots: z.array(z.string()),
    commands: z.array(z.string()),
    env: z.array(z.string()),
}) satisfies z.ZodType<ProjectConfig>;

export type PlannedIssue = { sha: string; period: Period; project: ProjectConfig; context: IssueContext };

export const PlannedIssue = z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    period: z.enum(PERIODS),
    project: ProjectData,
    context: IssueContextData,
}) satisfies z.ZodType<PlannedIssue>;

// The plan reaches the fix and publish jobs as an artifact. Only its hash and the issue keys go through job
// outputs, which GitHub keeps out of reach of the jobs that read them, so each reader checks the bytes it got.
export const PLAN_FILE = 'plan.json';

export type PlanKey = { id: string; shortId: string };

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function encodePlan(planned: readonly PlannedIssue[]): { bytes: Buffer; sha256: string; keys: PlanKey[] } {
    const bytes = Buffer.from(JSON.stringify(planned), 'utf8');
    return { bytes, sha256: sha256(bytes), keys: planned.map(({ context: { issue } }) => ({ id: issue.id, shortId: issue.shortId })) };
}

export function decodePlan(bytes: Uint8Array, expected: string): PlannedIssue[] {
    const actual = sha256(bytes);
    if (actual !== expected.toLowerCase()) throw new Error(`the plan file has SHA-256 ${actual}, but the plan job wrote ${expected}`);
    return parseJson(Buffer.from(bytes).toString('utf8'), z.array(PlannedIssue), 'the plan file');
}

export const readPlan = async (path: string, expected: string): Promise<PlannedIssue[]> => decodePlan(await readFile(path), expected);

export function plannedIssue(plan: readonly PlannedIssue[], id: string): PlannedIssue {
    const found = plan.find((planned) => planned.context.issue.id === id);
    if (found === undefined) throw new Error(`the plan has no issue ${id}`);
    return found;
}

export type ChangedFile = Change & { content: string | null };

const ChangedFileData = z.object({
    path: z.string().min(1),
    status: z.enum(['added', 'modified', 'deleted']),
    mode: z.string(),
    content: z.string().nullable(),
}) satisfies z.ZodType<ChangedFile>;

// A project command the workflow ran itself after the agent finished. A null exit code means it did not finish.
export type CommandRun = { command: string; exitCode: number | null; tail: string };

export const CommandRunData = z.object({ command: z.string(), exitCode: z.number().int().nullable(), tail: z.string() }) satisfies z.ZodType<CommandRun>;

export const passed = (run: CommandRun): boolean => run.exitCode === 0;

export type FixStats = { billing: string; costUsd: number; turns: number; durationMs: number; denied: string[] };

export const FixStatsData = z.object({
    billing: z.string(),
    costUsd: z.number(),
    turns: z.number(),
    durationMs: z.number(),
    denied: z.array(z.string()),
}) satisfies z.ZodType<FixStats>;

const GateData = z.union([z.object({ open: z.literal(true) }), z.object({ open: z.literal(false), reasons: z.array(z.string()) })]) satisfies z.ZodType<Gate>;

// Code in the fix job can rewrite this file, so it carries only what the fixer produced. The publish job takes
// the issue, the project and the base commit from the plan job's output.
// failed is an infrastructure error, retried next week with no note. exhausted is the fixer running out of budget,
// turns or time, which is a no-fix.
export type FixResult =
    | { status: 'failed'; error: string }
    | { status: 'exhausted'; reason: string }
    | { status: 'done'; output: FixOutput; verification: CommandRun[]; gate: Gate; changes: ChangedFile[]; stats: FixStats };

export const FixResult = z.discriminatedUnion('status', [
    z.object({ status: z.literal('failed'), error: z.string() }),
    z.object({ status: z.literal('exhausted'), reason: z.string() }),
    z.object({
        status: z.literal('done'),
        output: FixOutput,
        verification: z.array(CommandRunData),
        gate: GateData,
        changes: z.array(ChangedFileData),
        stats: FixStatsData,
    }),
]) satisfies z.ZodType<FixResult>;

export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try {
        body = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        throw new Error(`${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result = schema.safeParse(body);
    if (!result.success) throw new Error(`${path} is not valid: ${describeIssues(result.error)}`);
    return result.data;
}

export const parseJson = <T>(text: string, schema: z.ZodType<T>, what: string): T => {
    const result = schema.safeParse(JSON.parse(text));
    if (!result.success) throw new Error(`${what} is not valid: ${describeIssues(result.error)}`);
    return result.data;
};
