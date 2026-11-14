import { z } from 'zod';
import type { SentryIssue } from './sentry.ts';

export const MAX_FRAMES = 30;
const MESSAGE_LIMIT = 2_000;
const FIELD_LIMIT = 300;
const TITLE_LIMIT = 300;

export type Frame = { file: string | null; module: string | null; fn: string | null; line: number | null; inApp: boolean };

// Built only from allowlisted event fields. Request data, user context, breadcrumbs, cookies, headers,
// query strings and the extra and context blobs can hold student data, so they never get here.
export type IssueContext = {
    issue: SentryIssue;
    message: string;
    frames: Frame[];
    release: string | null;
    platform: string;
    transaction: string | null;
};

const text = z.string().nullish().catch(null);

const FrameBody = z.object({
    filename: text,
    absPath: text,
    module: text,
    function: text,
    lineNo: z.number().int().nullish().catch(null),
    inApp: z.boolean().nullish().catch(null),
});

const ExceptionEntry = z.object({
    type: z.literal('exception'),
    data: z.object({
        values: z
            .array(
                z.object({
                    type: text,
                    value: text,
                    stacktrace: z.object({ frames: z.array(FrameBody).nullish() }).nullish().catch(null),
                }),
            )
            .nullish(),
    }),
});

const MessageEntry = z.object({ type: z.literal('message'), data: z.object({ formatted: text, message: text }) });

const EventBody = z.object({
    platform: text,
    entries: z.array(z.unknown()).nullish().catch(null),
    tags: z
        .array(z.object({ key: z.string(), value: z.string().nullish() }))
        .nullish()
        .catch(null),
});

const clip = (value: string, limit: number): string => (value.length > limit ? `${value.slice(0, limit)}...` : value);

const withoutQuery = (value: string): string => value.split(/[?#]/, 1)[0] ?? '';

const field = (value: string | null | undefined): string | null => (value ? clip(withoutQuery(value), FIELD_LIMIT) : null);

type FrameData = z.infer<typeof FrameBody>;

const toFrame = (frame: FrameData): Frame => ({
    file: field(frame.filename ?? frame.absPath),
    module: field(frame.module),
    fn: frame.function ? clip(frame.function, FIELD_LIMIT) : null,
    line: frame.lineNo ?? null,
    inApp: frame.inApp === true,
});

// Sentry lists frames oldest first. The fixer wants the throwing frame first and the app's own code ahead of libraries.
export function orderFrames(oldestFirst: readonly FrameData[]): Frame[] {
    const newestFirst = oldestFirst.map(toFrame).reverse();
    return [...newestFirst.filter((frame) => frame.inApp), ...newestFirst.filter((frame) => !frame.inApp)].slice(0, MAX_FRAMES);
}

function parseEntries(entries: readonly unknown[]) {
    const exceptions = entries.flatMap((entry) => {
        const parsed = ExceptionEntry.safeParse(entry);
        return parsed.success ? (parsed.data.data.values ?? []) : [];
    });
    const message = entries.flatMap((entry) => {
        const parsed = MessageEntry.safeParse(entry);
        return parsed.success ? [parsed.data.data.formatted ?? parsed.data.data.message ?? ''] : [];
    })[0];
    return { exceptions, message };
}

export function issueContext(issue: SentryIssue, event: unknown): IssueContext {
    const parsed = EventBody.safeParse(event);
    const body = parsed.success ? parsed.data : { platform: null, entries: null, tags: null };
    const { exceptions, message } = parseEntries(body.entries ?? []);
    // The last exception is the one that was thrown, the earlier ones are its causes.
    const thrown = exceptions.at(-1);
    const withFrames = [...exceptions].reverse().find((exception) => (exception.stacktrace?.frames?.length ?? 0) > 0);
    const tag = (key: string) => body.tags?.find((t) => t.key === key)?.value ?? null;
    const thrownText = thrown ? [thrown.type, thrown.value].filter(Boolean).join(': ') : '';
    return {
        issue: { ...issue, title: clip(issue.title, TITLE_LIMIT), culprit: clip(issue.culprit, FIELD_LIMIT) },
        message: clip(thrownText || message || issue.title, MESSAGE_LIMIT),
        frames: orderFrames(withFrames?.stacktrace?.frames ?? []),
        release: field(tag('release')),
        platform: body.platform ?? 'unknown',
        transaction: field(tag('transaction')),
    };
}

export const frameLine = (frame: Frame): string => {
    const where = frame.file ? `${frame.file}${frame.line === null ? '' : `:${frame.line}`}` : (frame.module ?? '?');
    return `${frame.inApp ? '' : '[lib] '}${where} in ${frame.fn ?? '?'}`;
};
