import { z } from 'zod';
import type { ParseResult } from '../jev/ask.ts';
import { describeIssues, noulAnswer, usage } from '../jev/response.ts';
import type { Questions } from '../jev/state.ts';
import type { LabelRule } from './config.ts';

export type LabelAnswers = { model: string; inputTokens: number; probabilities: Map<string, number> };

const questionId = (index: number): string => `label_${index}`;

export const labelQuestions = (rules: readonly LabelRule[]): Questions =>
    Object.fromEntries(
        rules.map((rule, index) => [
            questionId(index),
            {
                type: 'noul',
                instructions: rule.instructions,
                ...(rule.criteria === undefined ? {} : { criteria: rule.criteria }),
            },
        ]),
    );

export const parseLabelResponse =
    (rules: readonly LabelRule[]) =>
    (body: unknown): ParseResult<LabelAnswers> => {
        const shape = Object.fromEntries(rules.map((_, index) => [questionId(index), noulAnswer]));
        const result = z.object({ model: z.string(), answers: z.object(shape), usage }).safeParse(body);
        if (!result.success) return { ok: false, error: `unexpected response: ${describeIssues(result.error, 'response')}` };
        const { model, answers, usage: tokens } = result.data;
        const probabilities = new Map(rules.map((rule, index) => [rule.name, answers[questionId(index)]!.noul]));
        return { ok: true, value: { model, inputTokens: tokens.input_tokens, probabilities } };
    };
