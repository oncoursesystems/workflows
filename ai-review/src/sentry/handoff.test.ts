import { describe, expect, it } from 'vitest';
import { fitPlan, type PlannedIssue } from './handoff.ts';
import { issueContextOf } from './testing.ts';

const planned = (frames: number): PlannedIssue => ({
    sha: 'a'.repeat(40),
    period: '7d',
    project: { slug: 'p', description: 'd', roots: ['src'], commands: [], env: [] },
    context: issueContextOf(undefined, {
        frames: Array.from({ length: frames }, (_, i) => ({ file: `src/${'f'.repeat(250)}${i}.js`, module: null, fn: 'fn', line: i, inApp: true })),
    }),
});

describe('fitPlan', () => {
    it('keeps a plan that fits as it is', () => {
        const plan = [planned(30), planned(30)];
        expect(fitPlan(plan)).toEqual(plan);
    });

    it('halves the frames of every issue until the plan fits', () => {
        const plan = [planned(30), planned(30)];
        const limit = JSON.stringify([planned(15), planned(15)]).length;
        expect(fitPlan(plan, limit).map((issue) => issue.context.frames.length)).toEqual([15, 15]);
    });

    it('fails when the plan does not fit even without frames', () => {
        expect(() => fitPlan([planned(1)], 100)).toThrow('lower the limit');
    });
});
