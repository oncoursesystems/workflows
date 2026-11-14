import { describe, expect, it } from 'vitest';
import { MAX_FRAMES, frameLine, issueContext } from './context.ts';
import { sentryIssue } from './testing.ts';

const frame = (fields: Record<string, unknown>) => ({
    filename: null,
    absPath: null,
    module: null,
    function: null,
    lineNo: null,
    inApp: false,
    vars: { studentName: 'Jane Doe' },
    context: [[1, 'const ssn = row.ssn;']],
    ...fields,
});

const EVENT = {
    platform: 'javascript',
    tags: [
        { key: 'release', value: 'OnCourse.Web@2026.11.01.1200' },
        { key: 'transaction', value: '/gradebook/student?id=4412&token=abc#tab' },
        { key: 'user.email', value: 'teacher@district.org' },
    ],
    user: { email: 'teacher@district.org', ip_address: '10.0.0.1' },
    contexts: { browser: { name: 'Chrome' } },
    extra: { studentId: 4412 },
    entries: [
        { type: 'breadcrumbs', data: { values: [{ message: 'clicked Jane Doe' }] } },
        { type: 'request', data: { url: 'https://x/?token=abc', cookies: [['session', 's3cret']], headers: [['Authorization', 'Bearer t']] } },
        {
            type: 'exception',
            data: {
                values: [
                    { type: 'Error', value: 'the cause', stacktrace: { frames: [frame({ filename: 'cause.js' })] } },
                    {
                        type: 'TypeError',
                        value: "Cannot read properties of undefined (reading 'id')",
                        stacktrace: {
                            frames: [
                                frame({ filename: 'node_modules/ext/ext-all.js', function: 'fire', lineNo: 1 }),
                                frame({ filename: 'app/view/gradebook/Main.js?v=1234', function: 'load', lineNo: 10, inApp: true }),
                                frame({ filename: 'node_modules/ext/ext-all.js', function: 'callback', lineNo: 2 }),
                                frame({ absPath: 'https://app.oncourse/app/view/gradebook/Grid.js', function: 'onLoad', lineNo: 42, inApp: true }),
                            ],
                        },
                    },
                ],
            },
        },
    ],
};

describe('issueContext', () => {
    it('keeps the thrown exception, its frames in-app first and newest first, the release and the path', () => {
        expect(issueContext(sentryIssue(), EVENT)).toEqual({
            issue: sentryIssue(),
            message: "TypeError: Cannot read properties of undefined (reading 'id')",
            frames: [
                { file: 'https://app.oncourse/app/view/gradebook/Grid.js', module: null, fn: 'onLoad', line: 42, inApp: true },
                { file: 'app/view/gradebook/Main.js', module: null, fn: 'load', line: 10, inApp: true },
                { file: 'node_modules/ext/ext-all.js', module: null, fn: 'callback', line: 2, inApp: false },
                { file: 'node_modules/ext/ext-all.js', module: null, fn: 'fire', line: 1, inApp: false },
            ],
            release: 'OnCourse.Web@2026.11.01.1200',
            platform: 'javascript',
            transaction: '/gradebook/student',
        });
    });

    it('never carries request data, user context, breadcrumbs, cookies, headers, query strings, extra, contexts or frame variables', () => {
        const text = JSON.stringify(issueContext(sentryIssue(), EVENT));
        for (const leak of ['teacher@district.org', '10.0.0.1', 'Jane Doe', 's3cret', 'Bearer t', 'token=abc', '4412', 'Chrome', 'ssn', 'v=1234']) {
            expect(text).not.toContain(leak);
        }
    });

    it('keeps at most 30 frames', () => {
        const frames = Array.from({ length: 50 }, (_, i) => frame({ filename: `f${i}.js`, inApp: true }));
        const context = issueContext(sentryIssue(), { entries: [{ type: 'exception', data: { values: [{ type: 'E', stacktrace: { frames } }] } }] });
        expect(context.frames).toHaveLength(MAX_FRAMES);
        expect(context.frames[0]?.file).toBe('f49.js');
    });

    it('keeps a .NET frame that has only a module', () => {
        const event = {
            platform: 'csharp',
            entries: [
                {
                    type: 'exception',
                    data: {
                        values: [
                            {
                                type: 'System.NullReferenceException',
                                value: 'Object reference not set to an instance of an object.',
                                stacktrace: { frames: [frame({ module: 'OnCourse.Web.Services.GradebookService', function: 'Load', inApp: true })] },
                            },
                        ],
                    },
                },
            ],
        };
        const context = issueContext(sentryIssue({ project: 'oncourse-dotnet' }), event);
        expect(context.frames).toEqual([{ file: null, module: 'OnCourse.Web.Services.GradebookService', fn: 'Load', line: null, inApp: true }]);
        expect(frameLine(context.frames[0]!)).toBe('OnCourse.Web.Services.GradebookService in Load');
        expect(context.platform).toBe('csharp');
    });

    it('falls back to the message entry, then to the issue title, when there is no exception', () => {
        expect(issueContext(sentryIssue(), { entries: [{ type: 'message', data: { formatted: 'Login failed' } }] }).message).toBe('Login failed');
        expect(issueContext(sentryIssue({ title: 'Title' }), { entries: 'garbage' })).toMatchObject({
            message: 'Title',
            frames: [],
            release: null,
            platform: 'unknown',
            transaction: null,
        });
    });
});

describe('issueContext limits', () => {
    it('clips a long title and culprit', () => {
        const context = issueContext(sentryIssue({ title: 'x'.repeat(5_000), culprit: 'y'.repeat(5_000) }), {});
        expect(context.issue.title.length).toBeLessThan(400);
        expect(context.issue.culprit.length).toBeLessThan(400);
    });
});
