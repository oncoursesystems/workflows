import { describe, expect, it } from 'vitest';
import { askJev, type ParseResult } from './ask.ts';
import { stateBudgetChars, type Questions } from './state.ts';
import { file, json, options, pr, tooLong, type Call } from './testing.ts';

const questions = { q: { type: 'noul', instructions: 'Is it?' } };
const parse = (body: unknown): ParseResult<unknown> => ({ ok: true, value: body });
const ask = (files: ReturnType<typeof file>[], responses: Array<() => Response>, calls: Call[], q: Questions = questions) =>
    askJev({ pr: pr(files), files, questions: q, parse }, options(responses, calls, []));

describe('askJev', () => {
    it('sends the model, the questions, and the pull request state, and returns the parsed body', async () => {
        const calls: Call[] = [];
        const result = await ask([file('a.js', '+a')], [json(200, { answer: 1 })], calls);
        expect(result).toEqual({ status: 'answered', value: { answer: 1 }, diff: 'complete' });
        expect(calls[0]?.body['model']).toBe('jev-1.14.0');
        expect(calls[0]?.body['questions']).toEqual(questions);
        expect(calls[0]?.body['state']).toMatchObject({ pull_request: { title: 'Title' }, diff: expect.stringContaining('+a') });
    });

    it('fails with the parser error when the response does not parse', async () => {
        const result = await askJev(
            { pr: pr([]), files: [], questions, parse: () => ({ ok: false, error: 'unexpected response: nope' }) },
            options([json(200, {})], [], []),
        );
        expect(result).toEqual({ status: 'failed', error: 'unexpected response: nope' });
    });

    it('counts the file list and description against the state budget', async () => {
        const calls: Call[] = [];
        const files = Array.from({ length: 400 }, (_, i) => file(`src/Some/Deep/Folder/Module${i}/File${i}.cs`, 'x'.repeat(400)));
        await ask(files, [json(200, {})], calls);
        const state = calls[0]?.body['state'] as { diff: string };
        expect(state.diff).toMatch(/\[diff truncated: \d+ of 400 files shown\]$/);
        expect(JSON.stringify(state).length).toBeLessThanOrEqual(stateBudgetChars(questions) + 100);
    });

    it('leaves less state room when a question is long', async () => {
        const long = { q: { type: 'noul', instructions: { task: 'x'.repeat(20_000) } } };
        const files = Array.from({ length: 400 }, (_, i) => file(`src/Folder${i}/File${i}.cs`, 'x'.repeat(400)));
        const shortCalls: Call[] = [];
        const longCalls: Call[] = [];
        await ask(files, [json(200, {})], shortCalls);
        await ask(files, [json(200, {})], longCalls, long);
        const stateSize = (calls: Call[]) => JSON.stringify(calls[0]?.body['state']).length;
        expect(stateSize(longCalls)).toBeLessThanOrEqual(stateBudgetChars(long) + 100);
        expect(stateSize(longCalls)).toBeLessThan(stateSize(shortCalls) - 15_000);
    });

    it('lists only the files that fit when the file list alone is too large', async () => {
        const calls: Call[] = [];
        const files = Array.from({ length: 20_000 }, (_, i) => file(`src/Legacy/Project/Folder${i}/File${i}.cs`, '-x'));
        const result = await ask(files, [json(200, {})], calls);
        const state = calls[0]?.body['state'] as { files: unknown[]; files_truncated?: string };
        expect(result.status).toBe('answered');
        expect(calls).toHaveLength(1);
        expect(JSON.stringify(state).length).toBeLessThanOrEqual(stateBudgetChars(questions) + 200);
        expect(state.files_truncated).toBe(`${state.files.length} of 20000 files listed`);
    });

    it('halves the file list on each retry while the context is still exceeded', async () => {
        const calls: Call[] = [];
        const files = Array.from({ length: 20_000 }, (_, i) => file(`src/Legacy/Project/Folder${i}/File${i}.cs`, '-x'));
        const result = await ask(files, [tooLong(), tooLong(), tooLong(), json(200, {})], calls);
        const listed = calls.map((call) => (call.body['state'] as { files: unknown[] }).files.length);
        expect(result.status).toBe('answered');
        expect(listed[1]).toBe(listed[0]);
        expect(listed[2]).toBeLessThan(listed[1]! * 0.6);
        expect(listed[3]).toBeLessThan(listed[2]! * 0.6);
    });

    it('lists every file without a truncation note when they fit', async () => {
        const calls: Call[] = [];
        await ask([file('a.js', '+a'), file('b.js', '+b')], [json(200, {})], calls);
        const state = calls[0]?.body['state'] as { files: unknown[]; files_truncated?: string };
        expect(state.files).toHaveLength(2);
        expect(state).not.toHaveProperty('files_truncated');
    });

    it('drops a token-dense file but keeps the rest of the diff when the context is exceeded', async () => {
        const calls: Call[] = [];
        const result = await ask(
            [file('AppHost.cs', '+small-route'), file('webfont.css', `-${'\\e900;'.repeat(9_000)}`)],
            [tooLong(), json(200, {})],
            calls,
        );
        const secondDiff = (calls[1]?.body['state'] as { diff: string }).diff;
        expect(secondDiff).toContain('+small-route');
        expect(secondDiff).not.toContain('\\e900;');
        expect(secondDiff).toContain('[diff truncated: 1 of 2 files shown]');
        expect(result.status === 'answered' && result.diff).toBe('truncated');
    });

    it('retries once without the diff when the context is exceeded', async () => {
        const calls: Call[] = [];
        const result = await ask([file('a.js', '+secret-patch')], [tooLong(), json(200, {})], calls);
        const secondDiff = (calls[1]?.body['state'] as { diff: string }).diff;
        expect(secondDiff).not.toContain('secret-patch');
        expect(secondDiff).toContain('diff omitted');
        expect(result.status === 'answered' && result.diff).toBe('omitted');
    });

    it('fails when even the file list cannot shrink enough', async () => {
        const responses = Array.from({ length: 7 }, () => tooLong());
        const result = await ask([file('a.js', '+a')], responses, []);
        expect(result).toEqual({ status: 'failed', error: expect.stringContaining('exceeds the model context') });
    });

    it('returns a transport failure without retrying', async () => {
        const calls: Call[] = [];
        const result = await ask([file('a.js', '+a')], [json(401, { detail: 'bad key' })], calls);
        expect(calls).toHaveLength(1);
        expect(result).toEqual({ status: 'failed', error: expect.stringContaining('HTTP 401') });
    });
});
