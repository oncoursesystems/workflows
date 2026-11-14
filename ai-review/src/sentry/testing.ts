import type { IssueContext } from './context.ts';
import type { SentryIssue, SentryOptions } from './sentry.ts';

export const sentryIssue = (fields: Partial<SentryIssue> = {}): SentryIssue => ({
    id: '101',
    shortId: 'ONCOURSE-WEB-3K',
    title: "TypeError: Cannot read properties of undefined (reading 'id')",
    culprit: 'app/view/gradebook/Grid.js in onLoad',
    permalink: 'https://sentry.io/organizations/o/issues/101/',
    project: 'oncourse-web',
    count: 120,
    substatus: 'ongoing',
    level: 'error',
    ...fields,
});

export const issueContextOf = (issue: SentryIssue = sentryIssue(), fields: Partial<IssueContext> = {}): IssueContext => ({
    issue,
    message: "TypeError: Cannot read properties of undefined (reading 'id')",
    frames: [{ file: 'app/view/gradebook/Grid.js', module: null, fn: 'onLoad', line: 42, inApp: true }],
    release: 'OnCourse.Web@2026.11.01.1200',
    platform: 'javascript',
    transaction: '/gradebook',
    ...fields,
});

export type SentryCall = { method: string; url: URL; body: unknown };

export const fakeSentry = (route: (call: SentryCall) => unknown): { options: SentryOptions; calls: SentryCall[] } => {
    const calls: SentryCall[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const call = { method: init?.method ?? 'GET', url: new URL(String(input)), body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        const answer = route(call);
        if (answer instanceof Response) return answer;
        return new Response(JSON.stringify(answer ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { options: { token: 'sntrys_test', org: 'o', fetch: fetchImpl }, calls };
};
