import type { ChangedFile, PullRequest } from '../github/pull-request.ts';
import type { JevOptions } from './transport.ts';

export const file = (path: string, patch: string): ChangedFile => ({ path, status: 'modified', additions: 1, deletions: 0, patch });

export const pr = (files: ChangedFile[]): PullRequest => ({
    repo: 'o/r',
    number: 1,
    title: 'Title',
    body: 'Body',
    author: 'dev',
    baseRef: 'master',
    defaultBranch: 'master',
    headSha: 'abc',
    draft: false,
    files,
});

export type Call = { body: Record<string, unknown> };

const fakeFetch = (responses: Array<() => Response>, calls: Call[]): typeof fetch =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        const next = responses.shift();
        if (next === undefined) throw new Error('unexpected extra request');
        return next();
    }) as typeof fetch;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const tooLong = () => json(400, { detail: { error: 'max_tokens_exceeded' } });

export const options = (responses: Array<() => Response>, calls: Call[], sleeps: number[]): JevOptions => ({
    apiKey: 'key',
    model: 'jev-1.14.0',
    fetch: fakeFetch(responses, calls),
    sleep: async (ms) => {
        sleeps.push(ms);
    },
});
