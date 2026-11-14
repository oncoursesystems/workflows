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

// The publish job reads every planned issue from one environment variable, and Linux caps one at 128 KiB.
export const PLAN_OUTPUT_LIMIT = 100_000;

// Frames are the bulk of an issue, so every issue keeps fewer of them until the plan fits in one variable.
export function fitPlan(planned: readonly PlannedIssue[], limit = PLAN_OUTPUT_LIMIT): PlannedIssue[] {
    let frames = Math.max(0, ...planned.map((issue) => issue.context.frames.length));
    for (;;) {
        const fitted = planned.map((issue) => ({ ...issue, context: { ...issue.context, frames: issue.context.frames.slice(0, frames) } }));
        if (JSON.stringify(fitted).length <= limit) return fitted;
        if (frames === 0) throw new Error(`the plan is ${JSON.stringify(fitted).length} characters without frames, over the ${limit} limit; lower the limit`);
        frames = Math.floor(frames / 2);
    }
}

export type ChangedFile = Change & { content: string | null };

const ChangedFileData = z.object({
    path: z.string().min(1),
    status: z.enum(['added', 'modified', 'deleted']),
    mode: z.string(),
    content: z.string().nullable(),
}) satisfies z.ZodType<ChangedFile>;

export type FixStats = { billing: string; costUsd: number; turns: number; durationMs: number; denied: string[] };

const FixStatsData = z.object({
    billing: z.string(),
    costUsd: z.number(),
    turns: z.number(),
    durationMs: z.number(),
    denied: z.array(z.string()),
}) satisfies z.ZodType<FixStats>;

const GateData = z.union([z.object({ open: z.literal(true) }), z.object({ open: z.literal(false), reasons: z.array(z.string()) })]) satisfies z.ZodType<Gate>;

// Code in the fix job can rewrite this file, so it carries only what the fixer produced. The publish job takes
// the issue, the project and the base commit from the plan job's output.
export type FixResult =
    | { status: 'failed'; error: string }
    | { status: 'done'; output: FixOutput; gate: Gate; changes: ChangedFile[]; stats: FixStats };

export const FixResult = z.discriminatedUnion('status', [
    z.object({ status: z.literal('failed'), error: z.string() }),
    z.object({
        status: z.literal('done'),
        output: FixOutput,
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
