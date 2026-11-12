import { describe, expect, it } from 'vitest';
import { file, json, options, pr, type Call } from '../jev/testing.ts';
import { askJev, parseResponse } from './jev.ts';
import { EMPTY_POLICY, type Policy } from './policy.ts';

const goodBody = {
    model: 'jev-1.14.0',
    answers: {
        tier: { type: 'choice', choice: 'medium', confidence: 0.4, probabilities: { low: 0.2, medium: 0.7, high: 0.1 } },
        access_change: { type: 'noul', noul: 0.05 },
    },
    usage: { input_tokens: 1234, output_tokens: 4 },
};

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

    it('reports the diff coverage with the verdict', async () => {
        const result = await askJev(pr([file('a.js', '+a')]), noIgnore, options([json(200, goodBody)], [], []));
        expect(result.status === 'answered' && result.verdict.diff).toBe('complete');
    });

    it('returns a failure from the transport', async () => {
        const result = await askJev(pr([file('a.js', '+a')]), noIgnore, options([json(401, { detail: 'bad key' })], [], []));
        expect(result).toEqual({ status: 'failed', error: expect.stringContaining('HTTP 401') });
    });
});
