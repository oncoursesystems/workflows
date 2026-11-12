import { describe, expect, it } from 'vitest';
import type { LabelRule } from './config.ts';
import { labelQuestions, parseLabelResponse } from './questions.ts';

const rule = (name: string, overrides: Partial<LabelRule> = {}): LabelRule => ({
    name,
    instructions: `Is it ${name}?`,
    addAt: 0.7,
    removeAt: 0.3,
    ...overrides,
});

const rules = [rule('ai', { instructions: { task: 'Does it touch AI?' }, criteria: { true: 'yes', false: 'no' } }), rule('docs')];

describe('labelQuestions', () => {
    it('asks one noul question per label with its instructions and criteria verbatim', () => {
        const questions = Object.values(labelQuestions(rules));
        expect(questions).toEqual([
            { type: 'noul', instructions: { task: 'Does it touch AI?' }, criteria: { true: 'yes', false: 'no' } },
            { type: 'noul', instructions: 'Is it docs?' },
        ]);
    });

    it('does not put a label name or a threshold in any question', () => {
        const sent = JSON.stringify(labelQuestions([rule('secret-name', { instructions: 'Is it special?', addAt: 0.123 })]));
        expect(sent).not.toContain('secret-name');
        expect(sent).not.toContain('0.123');
    });
});

describe('parseLabelResponse', () => {
    const ids = Object.keys(labelQuestions(rules));
    const body = (answers: Record<string, unknown>) => ({ model: 'jev-1.14.0', answers, usage: { input_tokens: 321 } });
    const noul = (value: number) => ({ type: 'noul', noul: value });

    it('maps each answer back to its label', () => {
        const parsed = parseLabelResponse(rules)(body({ [ids[0]!]: noul(0.94), [ids[1]!]: noul(0.02) }));
        expect(parsed).toEqual({
            ok: true,
            value: { model: 'jev-1.14.0', inputTokens: 321, probabilities: new Map([['ai', 0.94], ['docs', 0.02]]) },
        });
    });

    it('rejects a response that lacks the answer for a label', () => {
        const parsed = parseLabelResponse(rules)(body({ [ids[0]!]: noul(0.94) }));
        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.error).toContain(ids[1]!);
    });

    it('rejects a probability outside 0 to 1', () => {
        const parsed = parseLabelResponse(rules)(body({ [ids[0]!]: noul(1.2), [ids[1]!]: noul(0.1) }));
        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.error).toContain(ids[0]!);
    });

    it('rejects an answer of another type', () => {
        const parsed = parseLabelResponse(rules)(body({ [ids[0]!]: { type: 'choice', choice: 'x' }, [ids[1]!]: noul(0.1) }));
        expect(parsed.ok).toBe(false);
    });
});
