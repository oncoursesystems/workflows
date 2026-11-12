import { describe, expect, it } from 'vitest';
import { json, options, type Call } from './testing.ts';
import { post, retryDelayMs } from './transport.ts';

describe('post', () => {
    it('retries 429 and 529 honoring retry-after, then succeeds', async () => {
        const calls: Call[] = [];
        const sleeps: number[] = [];
        const result = await post(
            '{}',
            options([json(429, {}, { 'retry-after': '7' }), json(529, {}), json(200, { ok: 1 })], calls, sleeps),
        );
        expect(result).toEqual({ kind: 'ok', body: { ok: 1 } });
        expect(calls).toHaveLength(3);
        expect(sleeps).toEqual([7000, 4000]);
    });

    it('gives up after three tries', async () => {
        const calls: Call[] = [];
        const result = await post('{}', options([json(529, {}), json(529, {}), json(529, { detail: 'overloaded' })], calls, []));
        expect(calls).toHaveLength(3);
        expect(result).toEqual({ kind: 'error', error: expect.stringContaining('HTTP 529') });
    });

    it('reports a context overflow so the caller can shrink the request', async () => {
        const result = await post('{}', options([json(400, { detail: { error: 'max_tokens_exceeded' } })], [], []));
        expect(result).toEqual({ kind: 'too-long' });
    });

    it('returns other HTTP errors without retrying', async () => {
        const calls: Call[] = [];
        const result = await post('{}', options([json(401, { detail: 'bad key' })], calls, []));
        expect(calls).toHaveLength(1);
        expect(result).toEqual({ kind: 'error', error: expect.stringContaining('HTTP 401') });
    });

    it('returns a timeout as an error', async () => {
        const timeout = () => {
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        };
        const result = await post('{}', options([timeout], [], []));
        expect(result).toEqual({ kind: 'error', error: 'timed out after 60s' });
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
