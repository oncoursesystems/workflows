import { z } from 'zod';
import { describeIssues } from '../jev/response.ts';
import type { Period } from './config.ts';

export const DEFAULT_SENTRY_URL = 'https://sentry.io';
export const RANKED_ISSUES = 50;
const ERROR_TEXT_LIMIT = 500;

export type SentryOptions = { token: string; org: string; baseUrl?: string; fetch?: typeof fetch };

export type SentryIssue = {
    id: string;
    shortId: string;
    title: string;
    culprit: string;
    permalink: string;
    project: string;
    count: number;
    substatus: string | null;
    level: string;
};

export class SentryApiError extends Error {
    override name = 'SentryApiError';
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

// Sentry sends counts as strings.
const count = z.union([z.string(), z.number()]).transform(Number).pipe(z.number().int().nonnegative());

export const IssueBody = z
    .object({
        id: z.string().min(1),
        shortId: z.string().min(1),
        title: z.string(),
        culprit: z.string().nullish(),
        permalink: z.string(),
        project: z.object({ slug: z.string() }),
        count,
        substatus: z.string().nullish(),
        level: z.string().nullish(),
    })
    .transform(
        (issue): SentryIssue => ({
            id: issue.id,
            shortId: issue.shortId,
            title: issue.title,
            culprit: issue.culprit ?? '',
            permalink: issue.permalink,
            project: issue.project.slug,
            count: issue.count,
            substatus: issue.substatus ?? null,
            level: issue.level ?? 'error',
        }),
    );

const ProjectBody = z.object({ id: z.string().min(1), slug: z.string() });
const NoteBody = z.object({ type: z.string(), data: z.object({ text: z.string().nullish() }) });

const parse = <T>(schema: z.ZodType<T>, body: unknown, what: string): T => {
    const result = schema.safeParse(body);
    if (!result.success) throw new Error(`Sentry returned an unexpected ${what}: ${describeIssues(result.error, 'response')}`);
    return result.data;
};

async function call(options: SentryOptions, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    const url = `${options.baseUrl ?? DEFAULT_SENTRY_URL}/api/0/${path}`;
    const response = await (options.fetch ?? fetch)(url, {
        method,
        headers: {
            authorization: `Bearer ${options.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
        const text = (await response.text().catch(() => '')).slice(0, ERROR_TEXT_LIMIT);
        throw new SentryApiError(`Sentry ${method} /api/0/${path} failed with ${response.status}: ${text}`, response.status);
    }
    return response.status === 204 ? undefined : response.json();
}

const org = (options: SentryOptions) => `organizations/${encodeURIComponent(options.org)}`;
const issuePath = (options: SentryOptions, id: string) => `${org(options)}/issues/${encodeURIComponent(id)}`;

export async function projectId(options: SentryOptions, slug: string): Promise<string> {
    const body = await call(options, 'GET', `projects/${encodeURIComponent(options.org)}/${encodeURIComponent(slug)}/`);
    return parse(ProjectBody, body, `project ${slug}`).id;
}

export type IssueQuery = { projectIds: readonly string[]; environment: string; period: Period };

export const issueSearch = (environment: string): string => `is:unresolved environment:${JSON.stringify(environment)}`;

// `count` is the event count in statsPeriod and the environment, not the lifetime count, so it ranks the period.
export async function rankIssues(options: SentryOptions, query: IssueQuery): Promise<SentryIssue[]> {
    const params = new URLSearchParams([
        ...query.projectIds.map((id) => ['project', id]),
        ['environment', query.environment],
        ['query', issueSearch(query.environment)],
        ['statsPeriod', query.period],
        ['sort', 'freq'],
        ['limit', String(RANKED_ISSUES)],
    ]);
    const body = await call(options, 'GET', `${org(options)}/issues/?${params.toString()}`);
    const issues = parse(z.array(IssueBody), body, 'issue list');
    return issues.toSorted((a, b) => b.count - a.count);
}

export async function fetchIssue(options: SentryOptions, id: string): Promise<SentryIssue> {
    return parse(IssueBody, await call(options, 'GET', `${issuePath(options, id)}/`), `issue ${id}`);
}

export async function latestEvent(options: SentryOptions, id: string): Promise<unknown> {
    return call(options, 'GET', `${issuePath(options, id)}/events/latest/`);
}

export async function listNotes(options: SentryOptions, id: string): Promise<string[]> {
    const notes = parse(z.array(NoteBody), await call(options, 'GET', `${issuePath(options, id)}/comments/`), `note list of ${id}`);
    return notes.flatMap((note) => (note.type === 'note' && note.data.text ? [note.data.text] : []));
}

export async function postNote(options: SentryOptions, id: string, text: string): Promise<void> {
    await call(options, 'POST', `${issuePath(options, id)}/comments/`, { text });
}

// Sentry rejects inRelease for a release it has never seen, and an app reports a release only after it deploys.
// The endpoint answers 208 for a release that exists, and adds the projects it lacks.
export async function ensureRelease(options: SentryOptions, version: string, projects: readonly string[]): Promise<void> {
    await call(options, 'POST', `${org(options)}/releases/`, { version, projects });
}

export async function resolveInRelease(options: SentryOptions, id: string, release: string): Promise<void> {
    await call(options, 'PUT', `${issuePath(options, id)}/`, { status: 'resolved', statusDetails: { inRelease: release } });
}
