import { describe, expect, it } from 'vitest';
import { askJev, diffOfWholeFilesThatFit, parseResponse, retryDelayMs, STATE_BUDGET_CHARS, type JevOptions } from './jev.ts';
import { EMPTY_POLICY, type Policy } from './policy.ts';
import type { ChangedFile, PullRequest } from './pull-request.ts';

const file = (path: string, patch: string): ChangedFile => ({ path, status: 'modified', additions: 1, deletions: 0, patch });

const pr = (files: ChangedFile[]): PullRequest => ({
    repo: 'o/r',
    number: 1,
    title: 'Title',
    body: 'Body',
    author: 'dev',
    baseRef: 'master',
    headSha: 'abc',
    draft: false,
    files,
});

const goodBody = {
    model: 'jev-1.14.0',
    answers: {
        tier: { type: 'choice', choice: 'medium', confidence: 0.4, probabilities: { low: 0.2, medium: 0.7, high: 0.1 } },
        access_change: { type: 'noul', noul: 0.05 },
    },
    usage: { input_tokens: 1234, output_tokens: 4 },
};

describe('diffOfWholeFilesThatFit', () => {
    it('keeps every file when the diff fits', () => {
        const diff = diffOfWholeFilesThatFit([file('a.js', '+a'), file('b.js', '+b')], 1000);
        expect(diff.coverage).toBe('complete');
        expect(diff.text).toContain('+a');
        expect(diff.text).toContain('+b');
        expect(diff.text).not.toContain('[diff truncated');
    });

    it('marks a truncated diff with how many files it shows and stays within budget', () => {
        const files = [file('a.js', 'x'.repeat(300)), file('big.js', 'y'.repeat(5000)), file('c.js', 'z'.repeat(300))];
        const diff = diffOfWholeFilesThatFit(files, 1000);
        expect(diff.coverage).toBe('truncated');
        expect(diff.text.endsWith('[diff truncated: 2 of 3 files shown]')).toBe(true);
        expect(diff.text).not.toContain('yyyy');
        expect(diff.text).toContain('zzzz');
        expect(diff.text.length - '[diff truncated: 2 of 3 files shown]'.length).toBeLessThanOrEqual(1000);
    });

    it('names files that have no patch', () => {
        const diff = diffOfWholeFilesThatFit([{ path: 'logo.png', status: 'added', additions: 0, deletions: 0 }], 1000);
        expect(diff.text).toContain('logo.png');
        expect(diff.text).toContain('no patch');
    });
});

describe('parseResponse', () => {
    it('maps each answer to its verdict field', () => {
        expect(parseResponse(goodBody, false)).toEqual({
            ok: true,
            verdict: {
                model: 'jev-1.14.0',
                tier: 'medium',
                tierProbabilities: { low: 0.2, medium: 0.7, high: 0.1 },
                accessChange: 0.05,
                sensitiveArea: null,
                inputTokens: 1234,
            },
        });
    });

    it('rejects a response missing a question', () => {
        const { access_change: _, ...answers } = goodBody.answers;
        const parsed = parseResponse({ ...goodBody, answers }, false);
        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.error).toContain('access_change');
    });

    it('rejects a choice that is not a tier', () => {
        const parsed = parseResponse({ ...goodBody, answers: { ...goodBody.answers, tier: { ...goodBody.answers.tier, choice: 'critical' } } }, false);
        expect(parsed.ok).toBe(false);
    });
});

type Call = { body: Record<string, unknown> };

const fakeFetch = (responses: Array<() => Response>, calls: Call[]): typeof fetch =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        const next = responses.shift();
        if (next === undefined) throw new Error('unexpected extra request');
        return next();
    }) as typeof fetch;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const options = (responses: Array<() => Response>, calls: Call[], sleeps: number[]): JevOptions => ({
    apiKey: 'key',
    model: 'jev-1.14.0',
    fetch: fakeFetch(responses, calls),
    sleep: async (ms) => {
        sleeps.push(ms);
    },
});

const policyWith = (overrides: Partial<Policy> = {}): Policy => ({ ...EMPTY_POLICY, ...overrides });

describe('askJev', () => {
    const noIgnore = policyWith();

    it('sends only non-ignored files and the pinned model', async () => {
        const calls: Call[] = [];
        const result = await askJev(
            pr([file('app.js', '+app'), file('ext/ext-all.js', '+vendored')]),
            policyWith({ ignore: ['ext/**'] }),
            options([json(200, goodBody)], calls, []),
        );
        expect(result.status).toBe('answered');
        const state = calls[0]?.body['state'] as { files: Array<{ path: string }>; diff: string };
        expect(calls[0]?.body['model']).toBe('jev-1.14.0');
        expect(state.files.map((f) => f.path)).toEqual(['app.js']);
        expect(state.diff).not.toContain('vendored');
    });

    it('asks about sensitive areas only when the policy names them', async () => {
        const calls: Call[] = [];
        await askJev(pr([file('a.js', '+a')]), noIgnore, options([json(200, goodBody)], calls, []));
        expect(Object.keys(calls[0]?.body['questions'] as object)).toEqual(['tier', 'access_change']);

        const areas = [{ name: 'Grades and transcripts', covers: 'grades and GPAs (gradebook)' }];
        const withSensitive = { ...goodBody, answers: { ...goodBody.answers, sensitive_area: { type: 'noul', noul: 0.9 } } };
        const result = await askJev(
            pr([file('a.js', '+a')]),
            policyWith({ sensitiveAreas: areas }),
            options([json(200, withSensitive)], calls, []),
        );
        expect(JSON.stringify(calls[1]?.body['questions'])).toContain('Grades and transcripts');
        expect(result.status === 'answered' && result.verdict.sensitiveArea).toBe(0.9);
    });

    it('fails when a sensitive-area answer was asked for but is missing', async () => {
        const areas = [{ name: 'Money', covers: 'billing' }];
        const result = await askJev(
            pr([file('a.js', '+a')]),
            policyWith({ sensitiveAreas: areas }),
            options([json(200, goodBody)], [], []),
        );
        expect(result).toEqual({ status: 'failed', error: expect.stringContaining('sensitive_area') });
    });

    it('counts the file list and description against the state budget', async () => {
        const calls: Call[] = [];
        const files = Array.from({ length: 400 }, (_, i) => file(`src/Some/Deep/Folder/Module${i}/File${i}.cs`, 'x'.repeat(400)));
        await askJev(pr(files), noIgnore, options([json(200, goodBody)], calls, []));
        const state = calls[0]?.body['state'] as { diff: string };
        expect(state.diff).toMatch(/\[diff truncated: \d+ of 400 files shown\]$/);
        expect(JSON.stringify(state).length).toBeLessThanOrEqual(STATE_BUDGET_CHARS + 100);
    });

    it('lists only the files that fit when the file list alone is too large', async () => {
        const calls: Call[] = [];
        const files = Array.from({ length: 20_000 }, (_, i) => file(`src/Legacy/Project/Folder${i}/File${i}.cs`, '-x'));
        const result = await askJev(pr(files), noIgnore, options([json(200, goodBody)], calls, []));
        const state = calls[0]?.body['state'] as { files: unknown[]; files_truncated?: string };
        expect(result.status).toBe('answered');
        expect(calls).toHaveLength(1);
        expect(JSON.stringify(state).length).toBeLessThanOrEqual(STATE_BUDGET_CHARS + 200);
        expect(state.files_truncated).toBe(`${state.files.length} of 20000 files listed`);
    });

    it('halves the file list on each retry while the context is still exceeded', async () => {
        const calls: Call[] = [];
        const files = Array.from({ length: 20_000 }, (_, i) => file(`src/Legacy/Project/Folder${i}/File${i}.cs`, '-x'));
        const tooLong = () => json(400, { detail: { error: 'max_tokens_exceeded' } });
        const result = await askJev(pr(files), noIgnore, options([tooLong(), tooLong(), tooLong(), json(200, goodBody)], calls, []));
        const listed = calls.map((call) => (call.body['state'] as { files: unknown[] }).files.length);
        expect(result.status).toBe('answered');
        expect(listed[1]).toBe(listed[0]);
        expect(listed[2]).toBeLessThan(listed[1]! * 0.6);
        expect(listed[3]).toBeLessThan(listed[2]! * 0.6);
    });

    it('lists every file without a truncation note when they fit', async () => {
        const calls: Call[] = [];
        await askJev(pr([file('a.js', '+a'), file('b.js', '+b')]), noIgnore, options([json(200, goodBody)], calls, []));
        const state = calls[0]?.body['state'] as { files: unknown[]; files_truncated?: string };
        expect(state.files).toHaveLength(2);
        expect(state).not.toHaveProperty('files_truncated');
    });

    it('retries 429 and 529 honoring retry-after, then succeeds', async () => {
        const calls: Call[] = [];
        const sleeps: number[] = [];
        const result = await askJev(
            pr([file('a.js', '+a')]),
            noIgnore,
            options([json(429, {}, { 'retry-after': '7' }), json(529, {}), json(200, goodBody)], calls, sleeps),
        );
        expect(result.status).toBe('answered');
        expect(calls).toHaveLength(3);
        expect(sleeps).toEqual([7000, 4000]);
    });

    it('gives up after three tries', async () => {
        const calls: Call[] = [];
        const result = await askJev(
            pr([file('a.js', '+a')]),
            noIgnore,
            options([json(529, {}), json(529, {}), json(529, { detail: 'overloaded' })], calls, []),
        );
        expect(calls).toHaveLength(3);
        expect(result).toEqual({ status: 'failed', error: expect.stringContaining('HTTP 529') });
    });

    it('retries once without the diff when the context is exceeded', async () => {
        const calls: Call[] = [];
        const result = await askJev(
            pr([file('a.js', '+secret-patch')]),
            noIgnore,
            options([json(400, { detail: { error: 'max_tokens_exceeded' } }), json(200, goodBody)], calls, []),
        );
        const secondDiff = (calls[1]?.body['state'] as { diff: string }).diff;
        expect(secondDiff).not.toContain('secret-patch');
        expect(secondDiff).toContain('diff omitted');
        expect(result.status === 'answered' && result.verdict.diff).toBe('omitted');
    });

    it('returns other HTTP errors as a failure without retrying', async () => {
        const calls: Call[] = [];
        const result = await askJev(pr([file('a.js', '+a')]), noIgnore, options([json(401, { detail: 'bad key' })], calls, []));
        expect(calls).toHaveLength(1);
        expect(result).toEqual({ status: 'failed', error: expect.stringContaining('HTTP 401') });
    });

    it('returns a timeout as a failure', async () => {
        const timeout = () => {
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        };
        const result = await askJev(pr([file('a.js', '+a')]), noIgnore, options([timeout], [], []));
        expect(result).toEqual({ status: 'failed', error: 'timed out after 60s' });
    });
});

describe('retryDelayMs', () => {
    it('reads retry-after as seconds or a date and backs off exponentially without it', () => {
        expect(retryDelayMs('3', 0)).toBe(3000);
        const later = new Date(Date.now() + 10_000).toUTCString();
        expect(retryDelayMs(later, 0)).toBeGreaterThan(8000);
        expect([retryDelayMs(null, 0), retryDelayMs(null, 1)]).toEqual([2000, 4000]);
    });
});
