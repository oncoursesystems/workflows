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

export type FixResult =
    | { status: 'failed'; planned: PlannedIssue; error: string }
    | { status: 'done'; planned: PlannedIssue; output: FixOutput; gate: Gate; changes: ChangedFile[]; stats: FixStats };

export const FixResult = z.discriminatedUnion('status', [
    z.object({ status: z.literal('failed'), planned: PlannedIssue, error: z.string() }),
    z.object({
        status: z.literal('done'),
        planned: PlannedIssue,
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
